#!/usr/bin/env node
/**
 * Sprint 60 — consumer install smoke.
 *
 * The terminal step in the publish-readiness chain. Where Sprint 55
 * proved the CLI tarball extracts cleanly inside the workspace, this
 * sprint proves the *whole graph* — pir + codegen-core + 3 vendor
 * backends + cli — installs and runs as an external consumer would,
 * outside the workspace, with no `workspace:*` rewriting required.
 *
 * Pipeline:
 *
 *   1. Sanity check: every publish candidate has dist/index.js + .d.ts,
 *      is not `private: true`, and has no `workspace:*` runtime deps.
 *   2. `npm pack --json --pack-destination <tempRoot>/tarballs` for
 *      each of the six candidates.
 *   3. Extract each tarball and assert the same invariants on the
 *      packed package.json (npm pack does not rewrite either field).
 *   4. Create a brand-new consumer project at
 *      `<os.tmpdir()>/plccopilot-consumer-install-XXXX/consumer/`,
 *      `npm init -y`-style.
 *   5. `npm install --ignore-scripts <all six tarballs>` in topological
 *      order — pir/core first, vendors next, cli last — so npm picks
 *      the local tarball at every dep edge.
 *   6. Run the installed bin via `node_modules/.bin/plccopilot`:
 *      help, schema --name, schema --check, totally-unknown --json,
 *      inspect --json, validate --json, generate --json (siemens).
 *   7. Cleanup unless `PLC_COPILOT_KEEP_CONSUMER_SMOKE=1`.
 *
 * Why this exists outside the workspace temp dir:
 *
 *   Earlier smokes (sprint 55) extracted under `packages/cli/.tarball-smoke-tmp/`
 *   so the bin could resolve workspace symlinks. That hides workspace
 *   leakage. This script never touches workspace `node_modules` — it
 *   only walks the freshly-installed consumer tree, which is what a
 *   real npm consumer sees.
 *
 * Dependencies: Node built-ins + system `npm` + system `tar`.
 */

process.noDeprecation = true;

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(CLI_ROOT, '..', '..');
const PACKAGES_ROOT = resolve(REPO_ROOT, 'packages');
const WELDLINE_FIXTURE = resolve(
  PACKAGES_ROOT,
  'pir',
  'src',
  'fixtures',
  'weldline.json',
);

// Topological order: each tarball must be passed BEFORE the tarballs
// that depend on it so npm can satisfy 0.1.0 ranges from local files.
const CANDIDATES = [
  { dir: 'pir', name: '@plccopilot/pir' },
  { dir: 'codegen-core', name: '@plccopilot/codegen-core' },
  { dir: 'codegen-codesys', name: '@plccopilot/codegen-codesys' },
  { dir: 'codegen-rockwell', name: '@plccopilot/codegen-rockwell' },
  { dir: 'codegen-siemens', name: '@plccopilot/codegen-siemens' },
  { dir: 'cli', name: '@plccopilot/cli' },
];

const KEEP = process.env.PLC_COPILOT_KEEP_CONSUMER_SMOKE === '1';
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'plccopilot-consumer-install-'));
const TARBALL_DIR = join(TEMP_ROOT, 'tarballs');
const EXTRACT_DIR = join(TEMP_ROOT, 'extract');
const CONSUMER_DIR = join(TEMP_ROOT, 'consumer');
mkdirSync(TARBALL_DIR, { recursive: true });
mkdirSync(EXTRACT_DIR, { recursive: true });
mkdirSync(CONSUMER_DIR, { recursive: true });

function fail(message) {
  console.error(`Consumer install smoke FAILED: ${message}`);
  cleanup(true);
  process.exit(1);
}

function cleanup(failed = false) {
  if (KEEP) {
    console.error(`(keeping consumer smoke temp dir: ${TEMP_ROOT})`);
    return;
  }
  try {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch (e) {
    if (!failed) {
      console.error(
        `warning: could not remove ${TEMP_ROOT}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}

function truncate(s, max = 600) {
  if (typeof s !== 'string') return String(s);
  return s.length <= max ? s : `${s.slice(0, max)}…(truncated)`;
}

function runNpm(args, opts = {}) {
  return spawnSync('npm', args, {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    ...opts,
  });
}

function runTar(args, opts = {}) {
  return spawnSync('tar', args, {
    encoding: 'utf-8',
    ...opts,
  });
}

function inspectPackageManifest(pkg, label) {
  if (pkg.private === true) {
    fail(`${label}: package.json must not be private:true.`);
  }
  if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
    fail(`${label}: package.json missing "name".`);
  }
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    fail(`${label}: package.json missing "version".`);
  }
  if (pkg.main !== './dist/index.js') {
    fail(`${label}: "main" must be "./dist/index.js", got ${JSON.stringify(pkg.main)}`);
  }
  if (pkg.types !== './dist/index.d.ts') {
    fail(`${label}: "types" must be "./dist/index.d.ts", got ${JSON.stringify(pkg.types)}`);
  }
  const entry = pkg.exports?.['.'];
  const def =
    typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object'
        ? entry.default ?? entry.import ?? entry.require
        : null;
  const types =
    entry && typeof entry === 'object' && typeof entry.types === 'string'
      ? entry.types
      : null;
  if (def !== './dist/index.js') {
    fail(`${label}: exports["."].default must be "./dist/index.js", got ${JSON.stringify(def)}`);
  }
  if (types !== './dist/index.d.ts') {
    fail(`${label}: exports["."].types must be "./dist/index.d.ts", got ${JSON.stringify(types)}`);
  }
  for (const section of [
    'dependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const block = pkg[section];
    if (!block || typeof block !== 'object') continue;
    for (const [name, range] of Object.entries(block)) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        fail(
          `${label}: ${section}["${name}"] uses workspace protocol "${range}"; npm pack does not rewrite this — replace with explicit semver.`,
        );
      }
    }
  }
}

try {
  // -------------------------------------------------------------------------
  // 1. sanity: each candidate has dist + manifest is publishable
  // -------------------------------------------------------------------------

  const sourceManifests = {};
  for (const c of CANDIDATES) {
    const pkgDir = join(PACKAGES_ROOT, c.dir);
    const distJs = join(pkgDir, 'dist', 'index.js');
    const distDts = join(pkgDir, 'dist', 'index.d.ts');
    if (!existsSync(distJs) || !existsSync(distDts)) {
      fail(
        `${c.name}: ${
          existsSync(distJs) ? distDts : distJs
        } missing. Run 'pnpm build:packages-base && pnpm build:packages-vendor && pnpm cli:build'.`,
      );
    }
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));
    } catch (e) {
      fail(
        `${c.name}: cannot read source package.json (${
          e instanceof Error ? e.message : String(e)
        })`,
      );
    }
    inspectPackageManifest(pkg, `${c.name} (source)`);
    sourceManifests[c.dir] = pkg;
  }

  // -------------------------------------------------------------------------
  // 2. npm pack each candidate
  // -------------------------------------------------------------------------

  const tarballs = {};
  for (const c of CANDIDATES) {
    const pkgDir = join(PACKAGES_ROOT, c.dir);
    const result = runNpm(
      ['pack', '--json', '--pack-destination', TARBALL_DIR],
      { cwd: pkgDir },
    );
    if (result.status !== 0) {
      fail(
        `npm pack ${c.name} exited ${result.status}\n` +
          `  stdout: ${truncate(result.stdout)}\n` +
          `  stderr: ${truncate(result.stderr)}`,
      );
    }
    let manifest;
    try {
      const raw = result.stdout;
      try {
        manifest = JSON.parse(raw);
      } catch {
        const i = raw.indexOf('[');
        if (i < 0) throw new Error('no JSON array found');
        manifest = JSON.parse(raw.slice(i));
      }
    } catch (e) {
      fail(
        `${c.name}: cannot parse npm pack JSON: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    if (!Array.isArray(manifest) || !manifest[0]?.filename) {
      fail(`${c.name}: unexpected npm pack JSON shape`);
    }
    const filename = manifest[0].filename;
    const tgzPath = resolve(TARBALL_DIR, filename);
    if (!existsSync(tgzPath)) {
      fail(`${c.name}: tarball not found at ${tgzPath}`);
    }
    tarballs[c.dir] = tgzPath;
  }

  // -------------------------------------------------------------------------
  // 3. inspect each tarball's package.json post-pack
  // -------------------------------------------------------------------------

  for (const c of CANDIDATES) {
    const into = join(EXTRACT_DIR, c.dir);
    mkdirSync(into, { recursive: true });
    // GNU tar on MSYS interprets a leading drive letter (`C:`) as a
    // remote host. Pass the tarball as a path relative to the cwd
    // (which is on the same drive) to dodge that.
    const relTarball = relative(into, tarballs[c.dir]).split('\\').join('/');
    const tarResult = runTar(['-xzf', relTarball], { cwd: into });
    if (tarResult.status !== 0) {
      fail(
        `tar -xzf ${c.name} exited ${tarResult.status}: ${truncate(tarResult.stderr)}`,
      );
    }
    const packagedRoot = join(into, 'package');
    let packed;
    try {
      packed = JSON.parse(readFileSync(join(packagedRoot, 'package.json'), 'utf-8'));
    } catch (e) {
      fail(
        `${c.name}: cannot read packed package.json: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    inspectPackageManifest(packed, `${c.name} (packed)`);
    if (!existsSync(join(packagedRoot, 'dist', 'index.js'))) {
      fail(`${c.name}: packed dist/index.js missing.`);
    }
    if (!existsSync(join(packagedRoot, 'dist', 'index.d.ts'))) {
      fail(`${c.name}: packed dist/index.d.ts missing.`);
    }
  }

  // -------------------------------------------------------------------------
  // 4. consumer project + npm install (topological)
  // -------------------------------------------------------------------------

  writeFileSync(
    join(CONSUMER_DIR, 'package.json'),
    JSON.stringify(
      {
        name: 'plccopilot-consumer-smoke',
        version: '0.0.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  const installArgs = [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    ...CANDIDATES.map((c) => tarballs[c.dir]),
  ];
  const installResult = runNpm(installArgs, { cwd: CONSUMER_DIR });
  if (installResult.status !== 0) {
    fail(
      `npm install exited ${installResult.status}\n` +
        `  stdout: ${truncate(installResult.stdout)}\n` +
        `  stderr: ${truncate(installResult.stderr)}`,
    );
  }

  for (const c of CANDIDATES) {
    if (!existsSync(join(CONSUMER_DIR, 'node_modules', c.name, 'package.json'))) {
      fail(`consumer install: ${c.name} not present in node_modules.`);
    }
  }

  // -------------------------------------------------------------------------
  // 5. run the installed bin
  // -------------------------------------------------------------------------

  const isWindows = process.platform === 'win32';
  const binPath = join(
    CONSUMER_DIR,
    'node_modules',
    '.bin',
    isWindows ? 'plccopilot.cmd' : 'plccopilot',
  );
  if (!existsSync(binPath)) {
    fail(`consumer install: bin missing at ${binPath}`);
  }

  function runBin(args) {
    return spawnSync(binPath, args, {
      cwd: CONSUMER_DIR,
      encoding: 'utf-8',
      shell: isWindows, // .cmd on Windows
    });
  }

  // A. help
  {
    const r = runBin(['help']);
    if (r.status !== 0) {
      fail(
        `bin help exited ${r.status}\n  stdout: ${truncate(r.stdout)}\n  stderr: ${truncate(r.stderr)}`,
      );
    }
    if (!r.stdout.includes('plccopilot') || !r.stdout.includes('schema')) {
      fail(`bin help missing expected output: ${truncate(r.stdout)}`);
    }
  }

  // B. schema --name cli-result
  {
    const r = runBin(['schema', '--name', 'cli-result']);
    if (r.status !== 0) {
      fail(
        `bin schema cli-result exited ${r.status}\n  stderr: ${truncate(r.stderr)}`,
      );
    }
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch (e) {
      fail(`bin schema cli-result: stdout not JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    if (json.$id !== 'https://plccopilot.dev/schemas/cli-result.schema.json') {
      fail(`bin schema cli-result: $id mismatch: ${JSON.stringify(json.$id)}`);
    }
  }

  // C. schema --check against installed schemas
  {
    const installedSchemas = join(
      CONSUMER_DIR,
      'node_modules',
      '@plccopilot',
      'cli',
      'schemas',
    );
    if (!existsSync(installedSchemas)) {
      fail(`installed CLI is missing schemas/ at ${installedSchemas}`);
    }
    const r = runBin(['schema', '--check', installedSchemas]);
    if (r.status !== 0) {
      fail(
        `bin schema --check exited ${r.status}\n  stdout: ${truncate(r.stdout)}\n  stderr: ${truncate(r.stderr)}`,
      );
    }
    if (!r.stdout.includes('Schema files are in sync')) {
      fail(`bin schema --check: missing sync confirmation`);
    }
  }

  // D. totally-unknown --json
  {
    const r = runBin(['totally-unknown', '--json']);
    if (r.status !== 1) {
      fail(`bin unknown --json must exit 1, got ${r.status}`);
    }
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch (e) {
      fail(`bin unknown --json: stdout not JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    if (json.ok !== false || json.command !== 'unknown' || json.error?.name !== 'CliError') {
      fail(`bin unknown --json: unexpected payload ${truncate(JSON.stringify(json))}`);
    }
  }

  // Copy weldline fixture into the consumer for inspect/validate/generate.
  const fixtureDst = join(CONSUMER_DIR, 'weldline.json');
  copyFileSync(WELDLINE_FIXTURE, fixtureDst);

  // E. inspect --json
  {
    const r = runBin(['inspect', '--input', fixtureDst, '--json']);
    if (r.status !== 0) {
      fail(
        `bin inspect --json exited ${r.status}\n  stderr: ${truncate(r.stderr)}`,
      );
    }
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch (e) {
      fail(`bin inspect --json: stdout not JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    if (json.ok !== true || json.command !== 'inspect') {
      fail(`bin inspect --json: unexpected payload ${truncate(JSON.stringify(json))}`);
    }
    if (json.project?.id !== 'prj_weldline') {
      fail(`bin inspect --json: project.id mismatch: ${JSON.stringify(json.project?.id)}`);
    }
    if (typeof json.counts?.machines !== 'number' || json.counts.machines < 1) {
      fail(`bin inspect --json: counts.machines must be ≥ 1`);
    }
  }

  // F. validate --json
  {
    const r = runBin(['validate', '--input', fixtureDst, '--json']);
    if (r.status !== 0) {
      fail(
        `bin validate --json exited ${r.status}\n  stderr: ${truncate(r.stderr)}`,
      );
    }
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch (e) {
      fail(`bin validate --json: stdout not JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    if (json.command !== 'validate') {
      fail(`bin validate --json: command mismatch ${JSON.stringify(json.command)}`);
    }
  }

  // G. generate --backend siemens --json
  {
    const outDir = join(CONSUMER_DIR, 'out');
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
    if (r.status !== 0) {
      fail(
        `bin generate exited ${r.status}\n  stdout: ${truncate(r.stdout)}\n  stderr: ${truncate(r.stderr)}`,
      );
    }
    let json;
    try {
      json = JSON.parse(r.stdout);
    } catch (e) {
      fail(`bin generate --json: stdout not JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    if (json.ok !== true || json.command !== 'generate') {
      fail(`bin generate --json: unexpected payload ${truncate(JSON.stringify(json))}`);
    }
    if (!existsSync(join(outDir, 'siemens'))) {
      fail(`bin generate: out/siemens directory missing`);
    }
    const siemensFiles = readdirSync(join(outDir, 'siemens'));
    if (siemensFiles.length === 0) {
      fail(`bin generate: out/siemens is empty`);
    }
  }

  // -------------------------------------------------------------------------
  // 6. summary
  // -------------------------------------------------------------------------

  console.log(
    `Consumer install smoke passed. (${CANDIDATES.length} tarballs installed in ${
      CONSUMER_DIR
    }; help/schema/schema-check/unknown-json/inspect/validate/generate-siemens OK)`,
  );
} finally {
  cleanup();
}
