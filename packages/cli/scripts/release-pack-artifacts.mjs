#!/usr/bin/env node
// Sprint 62 — `pnpm release:pack-artifacts --out <dir>`.
//
// Packs every release candidate into <dir> and writes a manifest.json
// with one entry per tarball. Designed for CI's `actions/upload-artifact@v4`
// step so reviewers can download the exact six tarballs a publish
// would push (sourcemaps, declarations, schemas, no junk).
//
// Hardcoded `--pack-destination` ensures the script never silently
// drops tarballs into a developer's workspace. `--out` is required.
//
// Exit codes:
//   0  every candidate packed successfully
//   1  consistency check failed, npm pack failed, or the output set
//      did not match the canonical six-package list

process.noDeprecation = true;

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_PACKAGE_NAMES,
  RELEASE_PACKAGE_DIRS,
  checkReleaseState,
  loadReleaseWorkspace,
} from './release-plan-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

function die(message, code = 1) {
  process.stderr.write(`release-pack-artifacts: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { outDir: null, clean: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--out') {
      const next = argv[i + 1];
      if (!next) die('--out requires a path');
      out.outDir = resolve(process.cwd(), next);
      i++;
    } else if (a.startsWith('--out=')) {
      out.outDir = resolve(process.cwd(), a.slice('--out='.length));
    } else if (a === '--clean') {
      out.clean = true;
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  if (!out.help && !out.outDir) {
    die('--out <dir> is required');
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
  process.stdout.write(`pnpm release:pack-artifacts --out <dir> [--clean]

Packs every release candidate to <dir> using \`npm pack --json
--pack-destination <dir>\` and writes <dir>/manifest.json.

Use --clean to delete existing .tgz / manifest.json files in <dir>
before packing (useful in CI where the dir is fresh anyway, but
deterministic if it isn't).
`);
  process.exit(0);
}

const workspace = loadReleaseWorkspace(REPO_ROOT);
const { issues: stateIssues, sharedVersion } = checkReleaseState(workspace);
if (stateIssues.length > 0) {
  reportIssues(stateIssues);
  die('release consistency check failed; refusing to write artifacts.');
}

mkdirSync(args.outDir, { recursive: true });
if (args.clean) {
  for (const entry of readdirSync(args.outDir)) {
    if (entry.endsWith('.tgz') || entry === 'manifest.json') {
      rmSync(resolve(args.outDir, entry), { force: true });
    }
  }
}

const manifest = {
  version: sharedVersion,
  package_count: RELEASE_PACKAGE_DIRS.length,
  packages: [],
};

for (const c of workspace.candidates) {
  const expected = {
    name: EXPECTED_PACKAGE_NAMES[c.dir],
    version: sharedVersion,
  };
  const result = spawnSync(
    'npm',
    ['pack', '--json', '--pack-destination', args.outDir],
    {
      cwd: c.packageDir,
      encoding: 'utf-8',
      shell: process.platform === 'win32',
    },
  );
  if (result.status !== 0 || result.error) {
    process.stderr.write(
      `npm pack ${expected.name} failed (status=${result.status})\n  stderr: ${result.stderr ?? ''}\n`,
    );
    process.exit(1);
  }
  let parsed;
  try {
    const raw = result.stdout;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const i = raw.indexOf('[');
      parsed = JSON.parse(raw.slice(i));
    }
  } catch (e) {
    die(
      `cannot parse npm pack JSON for ${expected.name}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(parsed) || !parsed[0]?.filename) {
    die(`unexpected npm pack JSON shape for ${expected.name}`);
  }
  const entry = parsed[0];
  if (entry.name !== expected.name) {
    die(`pack reported name ${JSON.stringify(entry.name)} (expected ${expected.name})`);
  }
  if (entry.version !== expected.version) {
    die(`pack reported version ${JSON.stringify(entry.version)} (expected ${expected.version})`);
  }
  const tgzPath = resolve(args.outDir, entry.filename);
  if (!existsSync(tgzPath)) {
    die(`expected tarball at ${tgzPath} but it was not written.`);
  }
  manifest.packages.push({
    dir: c.dir,
    name: expected.name,
    version: expected.version,
    filename: entry.filename,
    size: statSync(tgzPath).size,
    unpacked_size: entry.unpackedSize ?? null,
    shasum: entry.shasum ?? null,
    integrity: entry.integrity ?? null,
    entry_count: Array.isArray(entry.files) ? entry.files.length : null,
  });
}

const tgzFiles = readdirSync(args.outDir).filter((f) => f.endsWith('.tgz'));
if (tgzFiles.length !== RELEASE_PACKAGE_DIRS.length) {
  die(
    `expected exactly ${RELEASE_PACKAGE_DIRS.length} tarballs in ${args.outDir}, found ${tgzFiles.length}: ${tgzFiles.join(', ')}`,
  );
}

const manifestPath = resolve(args.outDir, 'manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

process.stdout.write(
  `Release tarball artifacts written to ${args.outDir} ` +
    `(${RELEASE_PACKAGE_DIRS.length} packages at version ${sharedVersion}, manifest at ${manifestPath}).\n`,
);

// Inline guard against accidentally reading the just-written manifest
// to confirm everything we asserted above is consistent on disk.
const onDisk = JSON.parse(readFileSync(manifestPath, 'utf-8'));
if (onDisk.package_count !== RELEASE_PACKAGE_DIRS.length) {
  die(`written manifest reported ${onDisk.package_count} packages.`);
}
