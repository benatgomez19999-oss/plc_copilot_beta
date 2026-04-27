#!/usr/bin/env node
// Sprint 64 — `pnpm release:registry-smoke`.
//
// Manual post-publish verification: npm-installs `@plccopilot/cli@<version>`
// from a real registry into a fresh temp project under `os.tmpdir()`,
// then runs the installed bin through help / schema / inspect /
// validate / generate against the weldline fixture.
//
// This script is NOT part of `pnpm run ci`. It will fail with a
// clear "expected before the first publish" message if
// `@plccopilot/cli@<version>` is not yet on the registry.
//
// Modes:
//   pnpm release:registry-smoke                     # uses workspace version + npmjs.org
//   pnpm release:registry-smoke --version 0.1.0
//   pnpm release:registry-smoke --registry https://registry.npmjs.org
//   pnpm release:registry-smoke --package @plccopilot/cli
//   pnpm release:registry-smoke --keep              # keep temp dir on success
//   pnpm release:registry-smoke --help

process.noDeprecation = true;

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadReleaseWorkspace } from './release-plan-lib.mjs';
import {
  buildInstalledBinPath,
  buildNpmInstallArgs,
  isNpmNotFoundError,
  parseRegistrySmokeArgs,
  summarizeSpawnFailure,
  validateRegistrySmokeOptions,
} from './smoke-registry-install-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WELDLINE_FIXTURE = resolve(REPO_ROOT, 'packages', 'pir', 'src', 'fixtures', 'weldline.json');

const KEEP_ENV = process.env.PLC_COPILOT_KEEP_REGISTRY_SMOKE === '1';

function die(message, tempRoot, keep) {
  process.stderr.write(`Registry install smoke FAILED: ${message}\n`);
  cleanup(tempRoot, keep, /*failed*/ true);
  process.exit(1);
}

function cleanup(tempRoot, keep, failed = false) {
  if (!tempRoot) return;
  if (keep) {
    process.stderr.write(`(keeping registry smoke temp dir: ${tempRoot})\n`);
    return;
  }
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch (e) {
    if (!failed) {
      process.stderr.write(
        `warning: could not remove ${tempRoot}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
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

const parsed = parseRegistrySmokeArgs(process.argv.slice(2));
if (parsed.errors.length > 0) {
  reportIssues(parsed.errors);
  process.exit(1);
}
const rawOptions = parsed.options ?? {};
if (rawOptions.help) {
  process.stdout.write(`pnpm release:registry-smoke [--version X.Y.Z] [--registry URL] [--package @plccopilot/<pkg>] [--keep]

Manual post-publish verification. Installs @plccopilot/cli@<version>
from a real registry, runs the bin from a fresh temp project. Not in
ci:contracts; will fail before the first real publish.

Defaults:
  --version  workspace shared version (today: 0.1.0)
  --registry https://registry.npmjs.org
  --package  @plccopilot/cli

Set PLC_COPILOT_KEEP_REGISTRY_SMOKE=1 (or pass --keep) to keep the
temp directory after a successful run.
`);
  process.exit(0);
}

const workspace = loadReleaseWorkspace(REPO_ROOT);
const { options, issues: optionIssues } = validateRegistrySmokeOptions(rawOptions, workspace);
if (optionIssues.length > 0) {
  reportIssues(optionIssues);
  process.exit(1);
}

const keep = options.keep || KEEP_ENV;
const tempRoot = mkdtempSync(join(tmpdir(), 'plccopilot-registry-install-'));
const consumerDir = join(tempRoot, 'consumer');
mkdirSync(consumerDir, { recursive: true });

try {
  // -------------------------------------------------------------------------
  // 1. consumer project
  // -------------------------------------------------------------------------

  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify(
      {
        name: 'plccopilot-registry-smoke',
        version: '0.0.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  // -------------------------------------------------------------------------
  // 2. npm install <package>@<version> from registry
  // -------------------------------------------------------------------------

  const installArgs = buildNpmInstallArgs({
    packageName: options.packageName,
    version: options.version,
    registry: options.registry,
  });
  process.stdout.write(
    `Installing ${options.packageName}@${options.version} from ${options.registry} ...\n`,
  );
  const installResult = spawnSync('npm', [...installArgs], {
    cwd: consumerDir,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_registry: options.registry },
  });
  if (installResult.error || installResult.status !== 0) {
    if (isNpmNotFoundError(installResult.stderr, installResult.stdout)) {
      die(
        `npm install could not find ${options.packageName}@${options.version} on ${options.registry}.\n` +
          'This is expected before the first real publish. Run this smoke after the publish workflow completes.\n\n' +
          summarizeSpawnFailure('npm install', installResult),
        tempRoot,
        keep,
      );
    }
    die(summarizeSpawnFailure('npm install', installResult), tempRoot, keep);
  }

  // -------------------------------------------------------------------------
  // 3. resolve bin
  // -------------------------------------------------------------------------

  const binPath = buildInstalledBinPath(consumerDir);
  if (!existsSync(binPath)) {
    die(
      `installed CLI bin missing at ${binPath}. The package may have been published without a bin entry.`,
      tempRoot,
      keep,
    );
  }
  const isWindows = process.platform === 'win32';

  function runBin(args, opts = {}) {
    return spawnSync(binPath, args, {
      cwd: consumerDir,
      encoding: 'utf-8',
      shell: isWindows,
      ...opts,
    });
  }

  // -------------------------------------------------------------------------
  // 4. help / schema / unknown / inspect / validate / generate
  // -------------------------------------------------------------------------

  // A. help
  {
    const r = runBin(['help']);
    if (r.status !== 0)
      die(`bin help exited ${r.status}.\n  stderr: ${truncate(r.stderr)}`, tempRoot, keep);
    if (typeof r.stdout !== 'string' || !r.stdout.includes('plccopilot') || !r.stdout.includes('schema')) {
      die(`bin help missing expected output: ${truncate(r.stdout)}`, tempRoot, keep);
    }
  }

  // B. schema --name cli-result
  {
    const r = runBin(['schema', '--name', 'cli-result']);
    if (r.status !== 0)
      die(`bin schema cli-result exited ${r.status}.\n  stderr: ${truncate(r.stderr)}`, tempRoot, keep);
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch (e) {
      die(
        `bin schema cli-result: stdout not JSON (${e instanceof Error ? e.message : String(e)})`,
        tempRoot,
        keep,
      );
    }
    if (json.$id !== 'https://plccopilot.dev/schemas/cli-result.schema.json') {
      die(`bin schema cli-result: $id mismatch: ${JSON.stringify(json.$id)}`, tempRoot, keep);
    }
  }

  // C. schema --check against installed schemas
  {
    const installedSchemas = join(
      consumerDir,
      'node_modules',
      '@plccopilot',
      'cli',
      'schemas',
    );
    if (!existsSync(installedSchemas)) {
      die(
        `installed CLI is missing schemas/ at ${installedSchemas}.`,
        tempRoot,
        keep,
      );
    }
    const r = runBin(['schema', '--check', installedSchemas]);
    if (r.status !== 0)
      die(`bin schema --check exited ${r.status}.\n  stdout: ${truncate(r.stdout)}\n  stderr: ${truncate(r.stderr)}`, tempRoot, keep);
    if (typeof r.stdout !== 'string' || !r.stdout.includes('Schema files are in sync')) {
      die('bin schema --check: missing sync confirmation', tempRoot, keep);
    }
  }

  // D. totally-unknown --json
  {
    const r = runBin(['totally-unknown', '--json']);
    if (r.status !== 1) die(`bin unknown --json must exit 1, got ${r.status}.`, tempRoot, keep);
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch (e) {
      die(
        `bin unknown --json: stdout not JSON (${e instanceof Error ? e.message : String(e)})`,
        tempRoot,
        keep,
      );
    }
    if (json.ok !== false || json.command !== 'unknown' || json.error?.name !== 'CliError') {
      die(`bin unknown --json: unexpected payload ${truncate(JSON.stringify(json))}`, tempRoot, keep);
    }
  }

  // Copy weldline fixture from local repo (the published package does
  // not ship fixtures — that's by design).
  const fixtureDst = join(consumerDir, 'weldline.json');
  copyFileSync(WELDLINE_FIXTURE, fixtureDst);

  // E. inspect
  {
    const r = runBin(['inspect', '--input', fixtureDst, '--json']);
    if (r.status !== 0) die(`bin inspect --json exited ${r.status}.\n  stderr: ${truncate(r.stderr)}`, tempRoot, keep);
    const json = JSON.parse(r.stdout);
    if (json.ok !== true || json.command !== 'inspect') {
      die(`bin inspect --json: unexpected payload ${truncate(JSON.stringify(json))}`, tempRoot, keep);
    }
    if (json.project?.id !== 'prj_weldline') {
      die(`bin inspect --json: project.id mismatch: ${JSON.stringify(json.project?.id)}`, tempRoot, keep);
    }
  }

  // F. validate
  {
    const r = runBin(['validate', '--input', fixtureDst, '--json']);
    if (r.status !== 0) die(`bin validate --json exited ${r.status}.\n  stderr: ${truncate(r.stderr)}`, tempRoot, keep);
    const json = JSON.parse(r.stdout);
    if (json.command !== 'validate') {
      die(`bin validate --json: command mismatch ${JSON.stringify(json.command)}`, tempRoot, keep);
    }
  }

  // G. generate (siemens)
  {
    const outDir = join(consumerDir, 'out');
    mkdirSync(outDir, { recursive: true });
    const r = runBin([
      'generate',
      '--input',
      fixtureDst,
      '--backend',
      'siemens',
      '--out',
      outDir,
      '--json',
    ]);
    if (r.status !== 0) die(`bin generate exited ${r.status}.\n  stderr: ${truncate(r.stderr)}`, tempRoot, keep);
    const json = JSON.parse(r.stdout);
    if (json.ok !== true || json.command !== 'generate') {
      die(`bin generate --json: unexpected payload ${truncate(JSON.stringify(json))}`, tempRoot, keep);
    }
    if (!existsSync(join(outDir, 'siemens'))) {
      die('bin generate: out/siemens directory missing', tempRoot, keep);
    }
  }

  // -------------------------------------------------------------------------
  // 5. summary
  // -------------------------------------------------------------------------

  process.stdout.write(
    `Registry install smoke passed. (${options.packageName}@${options.version} from ${options.registry}; ` +
      'help/schema/schema-check/unknown-json/inspect/validate/generate-siemens OK)\n',
  );
  cleanup(tempRoot, keep);
  process.exit(0);
} catch (e) {
  die(`unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, tempRoot, keep);
}
