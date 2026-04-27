#!/usr/bin/env node
/**
 * Sprint 55 — real tarball extraction smoke for `@plccopilot/cli`.
 *
 * Where this fits in the release-hygiene chain:
 *
 *   source tests
 *   → dist smoke         (sprint 53)  bin works in the repo
 *   → dry-run pack smoke (sprint 54)  npm would pack the right files
 *   → tarball smoke      (sprint 55)  the real .tgz extracts and runs
 *
 * What this script does:
 *
 *   1. `npm pack --json --pack-destination <packDir>` to produce a real
 *      `.tgz` (no dry-run; this is the artifact a publish would push).
 *   2. Extracts the tarball with the system `tar` (Node has no built-in
 *      extractor; `tar` is on every CI image and POSIX dev box, and on
 *      Windows 10+ as `tar.exe`).
 *   3. Validates the extracted package: required files, forbidden
 *      entries, exact schema set, byte-equal schemas, package.json
 *      metadata.
 *   4. Runs the extracted bin's `help`, `schema --name`, `schema --check`,
 *      and the `totally-unknown --json` error envelope.
 *
 * Why the temp dir lives under `packages/cli/` (not `os.tmpdir()`):
 *
 *   The CLI's runtime imports `@plccopilot/codegen-core` and friends.
 *   In the workspace these are symlinks at `packages/cli/node_modules/
 *   @plccopilot/*` pointing at sibling packages (TS source, loaded via
 *   Node 24's built-in stripping). A real consumer would `npm install`
 *   the tarball and pull resolved versions of those deps; that's a
 *   separate "consumer install smoke" sprint.
 *
 *   For now we extract under `packages/cli/.tarball-smoke-tmp/` so the
 *   bin can resolve its declared deps via the workspace's existing
 *   node_modules walk. This still validates the parts that matter for
 *   release: pack contents, metadata, schema integrity, bin shebang +
 *   ESM imports, and the four user-facing commands listed above.
 *
 *   `os.tmpdir()` was tried; it puts the deps under the extracted
 *   `node_modules/`, which Node 24 refuses to type-strip on principle.
 *
 * Exit codes:
 *   0 — every check passed
 *   1 — any fatal check failed
 *
 * Cleanup:
 *   `try`/`finally` removes the temp dir. Set
 *   `PLC_COPILOT_KEEP_TARBALL_SMOKE=1` to keep it for debugging — the
 *   path is printed when the env var is set.
 *
 * Dependencies: Node built-ins + the system `tar` binary. No npm deps.
 */

// `shell: true` on Windows triggers DEP0190 for the npm spawn; args
// here are static literals, so the warning is noise.
process.noDeprecation = true;

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(CLI_ROOT, '..', '..');
const DIST_BIN = resolve(CLI_ROOT, 'dist', 'index.js');
const COMMITTED_SCHEMAS_DIR = resolve(CLI_ROOT, 'schemas');

const TEMP_ROOT = resolve(CLI_ROOT, '.tarball-smoke-tmp');
const PACK_DIR = join(TEMP_ROOT, 'pack');
const EXTRACT_DIR = join(TEMP_ROOT, 'extract');

const KEEP_TEMP = process.env.PLC_COPILOT_KEEP_TARBALL_SMOKE === '1';

const REQUIRED_ENTRIES = [
  'package.json',
  'dist/index.js',
  // Sprint 59: declarations are now part of the publish surface.
  'dist/index.d.ts',
  'schemas/cli-result.schema.json',
  'schemas/serialized-compiler-error.schema.json',
  'schemas/generate-summary.schema.json',
  'schemas/web-zip-summary.schema.json',
];

const FORBIDDEN_PREFIXES = [
  'src/',
  'tests/',
  'scripts/',
  'node_modules/',
];

const FORBIDDEN_EXACT = [
  'tsconfig.json',
  'tsconfig.build.json',
  'vitest.config.ts',
];

const FORBIDDEN_SUFFIXES = ['.tsbuildinfo'];

const EXPECTED_SCHEMA_FILES = [
  'cli-result.schema.json',
  'serialized-compiler-error.schema.json',
  'generate-summary.schema.json',
  'web-zip-summary.schema.json',
];

const REQUIRED_SCHEMA_EXPORTS = [
  './schemas/cli-result.schema.json',
  './schemas/serialized-compiler-error.schema.json',
  './schemas/generate-summary.schema.json',
  './schemas/web-zip-summary.schema.json',
];

function fail(message) {
  console.error(`CLI tarball smoke FAILED: ${message}`);
  cleanup(/* failed */ true);
  process.exit(1);
}

function truncate(s, max = 800) {
  if (typeof s !== 'string') return String(s);
  return s.length <= max ? s : `${s.slice(0, max)}…(truncated)`;
}

function cleanup(failed = false) {
  if (KEEP_TEMP) {
    console.error(
      `(keeping temp dir for debug: ${TEMP_ROOT})`,
    );
    return;
  }
  try {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch (e) {
    // Best-effort; do not mask the original failure.
    if (!failed) {
      console.error(
        `warning: could not remove ${TEMP_ROOT}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}

function listAllFiles(root) {
  const out = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  walk(root);
  return out;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

// ---------------------------------------------------------------------------
// 0. dist exists
// ---------------------------------------------------------------------------

if (!existsSync(DIST_BIN)) {
  fail(
    `dist binary missing: ${DIST_BIN}\n` +
      "Run 'pnpm cli:build' before invoking tarball smoke.",
  );
}

// ---------------------------------------------------------------------------
// 1. fresh temp dir (always rebuilt — never trust prior state)
// ---------------------------------------------------------------------------

try {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
} catch (e) {
  fail(
    `could not clear stale ${TEMP_ROOT}: ${
      e instanceof Error ? e.message : String(e)
    }`,
  );
}
mkdirSync(PACK_DIR, { recursive: true });
mkdirSync(EXTRACT_DIR, { recursive: true });

try {
  // -------------------------------------------------------------------------
  // 2. npm pack (real tarball)
  // -------------------------------------------------------------------------

  const npmResult = spawnSync(
    'npm',
    ['pack', '--json', '--pack-destination', PACK_DIR],
    {
      cwd: CLI_ROOT,
      encoding: 'utf-8',
      // Node 24 blocks direct .cmd execution on Windows (EINVAL); shell:true
      // is the official workaround. Args are literal strings only.
      shell: process.platform === 'win32',
    },
  );

  if (npmResult.error) {
    fail(`spawning npm pack failed: ${npmResult.error.message}`);
  }
  if (npmResult.status !== 0) {
    fail(
      `npm pack exited ${npmResult.status}\n` +
        `  stdout: ${truncate(npmResult.stdout)}\n` +
        `  stderr: ${truncate(npmResult.stderr)}`,
    );
  }

  let manifest;
  try {
    const raw = npmResult.stdout;
    try {
      manifest = JSON.parse(raw);
    } catch {
      const firstBracket = raw.indexOf('[');
      if (firstBracket < 0) throw new Error('no JSON array found in npm output');
      manifest = JSON.parse(raw.slice(firstBracket));
    }
  } catch (e) {
    fail(
      `cannot parse npm pack JSON: ${
        e instanceof Error ? e.message : String(e)
      }\n  stdout: ${truncate(npmResult.stdout)}`,
    );
  }
  if (!Array.isArray(manifest) || manifest.length === 0) {
    fail(`npm pack JSON must be a non-empty array`);
  }

  const packEntry = manifest[0];
  if (!packEntry || typeof packEntry.filename !== 'string') {
    fail(`npm pack JSON missing filename: ${truncate(JSON.stringify(packEntry))}`);
  }

  // npm 11 puts the tarball at <pack-destination>/<basename>; older
  // versions sometimes return a path relative to cwd. Resolve robustly.
  let tgzPath = resolve(PACK_DIR, packEntry.filename);
  if (!existsSync(tgzPath)) {
    const candidates = readdirSync(PACK_DIR).filter((n) => n.endsWith('.tgz'));
    if (candidates.length === 1) {
      tgzPath = join(PACK_DIR, candidates[0]);
    } else {
      fail(
        `tarball not found at ${tgzPath}; pack dir contents: ${candidates.join(', ') || '(empty)'}`,
      );
    }
  }
  const tgzSize = statSync(tgzPath).size;

  // -------------------------------------------------------------------------
  // 3. extract with system tar
  // -------------------------------------------------------------------------

  // GNU tar on MSYS reads "C:" as a remote host (rsh-style "user@host:"),
  // so we cannot pass a Windows absolute path as `-f`. Run tar with
  // cwd = EXTRACT_DIR and reference the tarball via a POSIX relative
  // path — that avoids the colon in argv entirely and works on both GNU
  // tar (Linux/MSYS) and bsdtar (Windows 10+).
  const tgzRel = toPosix(relative(EXTRACT_DIR, tgzPath));
  const tarResult = spawnSync('tar', ['-xzf', tgzRel], {
    cwd: EXTRACT_DIR,
    encoding: 'utf-8',
  });
  if (tarResult.error) {
    fail(
      `system tar command is required for this smoke (spawn failed: ${tarResult.error.message})`,
    );
  }
  if (tarResult.status !== 0) {
    fail(
      `tar -xzf exited ${tarResult.status}\n` +
        `  stdout: ${truncate(tarResult.stdout)}\n` +
        `  stderr: ${truncate(tarResult.stderr)}`,
    );
  }

  const PACKAGE_ROOT = join(EXTRACT_DIR, 'package');
  if (!existsSync(PACKAGE_ROOT)) {
    fail(
      `expected ${PACKAGE_ROOT} after extraction; got: ${readdirSync(EXTRACT_DIR).join(', ')}`,
    );
  }

  // -------------------------------------------------------------------------
  // 4. extracted package.json metadata
  // -------------------------------------------------------------------------

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
  } catch (e) {
    fail(
      `cannot read extracted package.json: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  if (pkg.name !== '@plccopilot/cli') {
    fail(`extracted name must be "@plccopilot/cli", got ${JSON.stringify(pkg.name)}`);
  }
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    fail(`extracted version must be a non-empty string, got ${JSON.stringify(pkg.version)}`);
  }
  // Sprint 60 — extracted package must be publishable as-is.
  if (pkg.private === true) {
    fail('extracted package.json must not be private:true.');
  }
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const block = pkg[section];
    if (!block || typeof block !== 'object') continue;
    for (const [name, range] of Object.entries(block)) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        fail(
          `extracted ${section}["${name}"] uses workspace protocol "${range}"; npm pack does not rewrite this.`,
        );
      }
    }
  }
  if (!pkg.bin || pkg.bin.plccopilot !== './dist/index.js') {
    // npm normalises bin paths to "./dist/index.js" on pack.
    const allowed = ['./dist/index.js', 'dist/index.js'];
    if (!pkg.bin || !allowed.includes(String(pkg.bin.plccopilot))) {
      fail(`extracted bin.plccopilot must be dist/index.js, got ${JSON.stringify(pkg.bin)}`);
    }
  }
  if (!Array.isArray(pkg.files) || !pkg.files.includes('dist') || !pkg.files.includes('schemas')) {
    fail(`extracted files must include "dist" and "schemas", got ${JSON.stringify(pkg.files)}`);
  }
  if (!pkg.exports || typeof pkg.exports !== 'object' || !('.' in pkg.exports)) {
    fail(`extracted exports must declare "."`);
  }
  for (const subpath of REQUIRED_SCHEMA_EXPORTS) {
    if (!(subpath in pkg.exports)) {
      fail(`extracted exports must declare ${JSON.stringify(subpath)}`);
    }
  }

  // Sprint 59: extracted exports["."] must point at compiled dist + types.
  const rootExport = pkg.exports['.'];
  const rootDefault =
    typeof rootExport === 'string'
      ? rootExport
      : rootExport && typeof rootExport === 'object'
        ? rootExport.default ?? rootExport.import ?? rootExport.require
        : null;
  const rootTypes =
    rootExport && typeof rootExport === 'object' && typeof rootExport.types === 'string'
      ? rootExport.types
      : null;
  if (rootDefault !== './dist/index.js') {
    fail(
      `extracted exports["."].default must be "./dist/index.js", got ${JSON.stringify(rootDefault)}`,
    );
  }
  if (rootTypes !== './dist/index.d.ts') {
    fail(
      `extracted exports["."].types must be "./dist/index.d.ts", got ${JSON.stringify(rootTypes)}`,
    );
  }
  if (pkg.types !== './dist/index.d.ts') {
    fail(
      `extracted "types" must be "./dist/index.d.ts", got ${JSON.stringify(pkg.types)}`,
    );
  }

  // -------------------------------------------------------------------------
  // 5. required + forbidden entries (recursive walk)
  // -------------------------------------------------------------------------

  const allFiles = listAllFiles(PACKAGE_ROOT).map((f) =>
    toPosix(relative(PACKAGE_ROOT, f)),
  );

  for (const required of REQUIRED_ENTRIES) {
    if (!allFiles.includes(required)) {
      fail(`extracted package missing required entry ${JSON.stringify(required)}`);
    }
  }

  for (const path of allFiles) {
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (path.startsWith(prefix)) {
        fail(
          `extracted package contains forbidden entry ${JSON.stringify(path)} (prefix ${JSON.stringify(prefix)})`,
        );
      }
    }
    for (const exact of FORBIDDEN_EXACT) {
      if (path === exact) {
        fail(`extracted package contains forbidden file ${JSON.stringify(path)}`);
      }
    }
    for (const suffix of FORBIDDEN_SUFFIXES) {
      if (path.endsWith(suffix)) {
        fail(
          `extracted package contains forbidden file ${JSON.stringify(path)} (suffix ${JSON.stringify(suffix)})`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 6. exact schema set + byte-equal vs committed
  // -------------------------------------------------------------------------

  const extractedSchemasDir = join(PACKAGE_ROOT, 'schemas');
  const extractedSchemaNames = readdirSync(extractedSchemasDir).sort();
  const expectedSorted = [...EXPECTED_SCHEMA_FILES].sort();

  if (extractedSchemaNames.length !== expectedSorted.length) {
    fail(
      `extracted schemas count mismatch: got [${extractedSchemaNames.join(', ')}], expected [${expectedSorted.join(', ')}]`,
    );
  }
  for (let i = 0; i < expectedSorted.length; i++) {
    if (extractedSchemaNames[i] !== expectedSorted[i]) {
      fail(
        `extracted schemas mismatch: got [${extractedSchemaNames.join(', ')}], expected [${expectedSorted.join(', ')}]`,
      );
    }
  }
  for (const name of EXPECTED_SCHEMA_FILES) {
    const extracted = readFileSync(join(extractedSchemasDir, name));
    const committed = readFileSync(join(COMMITTED_SCHEMAS_DIR, name));
    if (!extracted.equals(committed)) {
      fail(`extracted schema differs from committed schema: ${name}`);
    }
  }

  // -------------------------------------------------------------------------
  // 7. extracted bin runs help / schema / unknown
  // -------------------------------------------------------------------------

  const extractedBin = join(PACKAGE_ROOT, 'dist', 'index.js');

  function runBin(args) {
    return spawnSync(process.execPath, [extractedBin, ...args], {
      cwd: EXTRACT_DIR, // anywhere outside the original cli/src tree
      encoding: 'utf-8',
    });
  }

  // A. help
  {
    const r = runBin(['help']);
    if (r.status !== 0) {
      fail(
        `extracted bin: help exited ${r.status}\n` +
          `  stdout: ${truncate(r.stdout)}\n  stderr: ${truncate(r.stderr)}`,
      );
    }
    if (typeof r.stdout !== 'string' || !r.stdout.includes('plccopilot')) {
      fail(`extracted bin: help stdout missing "plccopilot": ${truncate(r.stdout)}`);
    }
    if (!r.stdout.includes('schema') || !r.stdout.includes('--json')) {
      fail(`extracted bin: help stdout missing schema/--json hints`);
    }
  }

  // B. schema --name cli-result
  {
    const r = runBin(['schema', '--name', 'cli-result']);
    if (r.status !== 0) {
      fail(
        `extracted bin: schema cli-result exited ${r.status}\n` +
          `  stdout: ${truncate(r.stdout)}\n  stderr: ${truncate(r.stderr)}`,
      );
    }
    if (r.stderr) {
      fail(`extracted bin: schema cli-result stderr should be empty, got ${truncate(r.stderr)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (e) {
      fail(
        `extracted bin: schema cli-result stdout is not JSON: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    if (parsed.$id !== 'https://plccopilot.dev/schemas/cli-result.schema.json') {
      fail(
        `extracted bin: schema cli-result $id mismatch: ${JSON.stringify(parsed.$id)}`,
      );
    }
    if (!Array.isArray(parsed.oneOf)) {
      fail(`extracted bin: schema cli-result must have oneOf[]`);
    }
  }

  // C. schema --check against the extracted schemas dir
  {
    const r = runBin(['schema', '--check', extractedSchemasDir]);
    if (r.status !== 0) {
      fail(
        `extracted bin: schema --check exited ${r.status}\n` +
          `  stdout: ${truncate(r.stdout)}\n  stderr: ${truncate(r.stderr)}`,
      );
    }
    if (r.stderr) {
      fail(`extracted bin: schema --check stderr should be empty, got ${truncate(r.stderr)}`);
    }
    if (!r.stdout.includes('Schema files are in sync')) {
      fail(
        `extracted bin: schema --check stdout missing sync confirmation: ${truncate(r.stdout)}`,
      );
    }
  }

  // D. unknown command --json
  {
    const r = runBin(['totally-unknown', '--json']);
    if (r.status !== 1) {
      fail(
        `extracted bin: unknown --json must exit 1, got ${r.status}\n` +
          `  stdout: ${truncate(r.stdout)}\n  stderr: ${truncate(r.stderr)}`,
      );
    }
    if (r.stderr) {
      fail(`extracted bin: unknown --json stderr should be empty, got ${truncate(r.stderr)}`);
    }
    let payload;
    try {
      payload = JSON.parse(r.stdout);
    } catch (e) {
      fail(
        `extracted bin: unknown --json stdout is not JSON: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    if (payload.ok !== false) {
      fail(`extracted bin: unknown --json ok must be false, got ${payload.ok}`);
    }
    if (payload.command !== 'unknown') {
      fail(
        `extracted bin: unknown --json command must be "unknown", got ${JSON.stringify(payload.command)}`,
      );
    }
    if (payload.error?.name !== 'CliError') {
      fail(
        `extracted bin: unknown --json error.name must be "CliError", got ${JSON.stringify(payload.error?.name)}`,
      );
    }
    if (
      typeof payload.error?.message !== 'string' ||
      !payload.error.message.includes('unknown command')
    ) {
      fail(
        `extracted bin: unknown --json error.message must mention "unknown command", got ${JSON.stringify(payload.error?.message)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 8. summary
  // -------------------------------------------------------------------------

  console.log(
    `CLI tarball smoke passed. (${allFiles.length} entries, ${EXPECTED_SCHEMA_FILES.length} schemas, tarball ${tgzSize} bytes)`,
  );
} finally {
  cleanup();
}
