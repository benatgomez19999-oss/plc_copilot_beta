#!/usr/bin/env node
/**
 * Sprint 54 — release pack smoke for `@plccopilot/cli`.
 *
 * Sprint 53's dist smoke proves `node dist/index.js` works inside the
 * repo. This script proves the package would be CONSUMABLE if it were
 * published: the right files end up in the tarball, the wrong files
 * don't, and `package.json`'s metadata is shaped the way bin / schema
 * consumers will rely on.
 *
 * Strategy: shell out to `npm pack --dry-run --json`, parse the JSON
 * manifest, then enforce a small contract:
 *   - required entries present (package.json, dist/index.js, all 4 schemas)
 *   - forbidden entries absent (src/, tests/, scripts/, configs, …)
 *   - exact schema set (no drift, no rogue files)
 *   - package.json metadata: name, bin, files, exports
 *
 * Pre-requisite: `pnpm cli:build`.
 *
 * Exit codes:
 *   0 — every check passed (warnings still allowed, see below)
 *   1 — any fatal check failed
 *
 * Warnings (non-fatal): emitted to stderr but do not flip the exit
 * code. Currently used for `exports["."]` pointing at source TS that
 * isn't part of the pack — a known workspace-vs-publish trade-off
 * documented in CONTRIBUTING.
 *
 * Dependencies: Node built-ins only (`child_process`, `fs`, `path`,
 * `url`). Matches Sprint 53's "no new deps" rule.
 */

// `shell: true` on Windows triggers DEP0190; args here are static
// literals (no user input), so the warning is noise.
process.noDeprecation = true;

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(CLI_ROOT, '..', '..');
const DIST_BIN = resolve(CLI_ROOT, 'dist', 'index.js');
const PACKAGE_JSON_PATH = resolve(CLI_ROOT, 'package.json');

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

// Anything starting with one of these prefixes (or matching exactly)
// must NOT make it into the tarball.
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

// The exact schema set — no extras tolerated. Drift here would
// mean either a new schema was added without updating consumers,
// or a stale file is shipping with the package.
const EXPECTED_SCHEMA_SET = new Set([
  'schemas/cli-result.schema.json',
  'schemas/serialized-compiler-error.schema.json',
  'schemas/generate-summary.schema.json',
  'schemas/web-zip-summary.schema.json',
]);

const REQUIRED_SCHEMA_EXPORTS = [
  './schemas/cli-result.schema.json',
  './schemas/serialized-compiler-error.schema.json',
  './schemas/generate-summary.schema.json',
  './schemas/web-zip-summary.schema.json',
];

let warnCount = 0;

function fail(message) {
  console.error(`CLI pack smoke FAILED: ${message}`);
  process.exit(1);
}

function warn(message) {
  console.error(`CLI pack smoke warning: ${message}`);
  warnCount++;
}

function truncate(s, max = 800) {
  if (typeof s !== 'string') return String(s);
  return s.length <= max ? s : `${s.slice(0, max)}…(truncated)`;
}

// ---------------------------------------------------------------------------
// 0. dist/index.js exists
// ---------------------------------------------------------------------------

if (!existsSync(DIST_BIN)) {
  fail(
    `dist binary missing: ${DIST_BIN}\n` +
      "Run 'pnpm cli:build' before invoking pack smoke.",
  );
}

// ---------------------------------------------------------------------------
// 1. package.json metadata
// ---------------------------------------------------------------------------

let pkg;
try {
  pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
} catch (e) {
  fail(
    `cannot read ${PACKAGE_JSON_PATH}: ${
      e instanceof Error ? e.message : String(e)
    }`,
  );
}

if (pkg.name !== '@plccopilot/cli') {
  fail(`package.json name must be "@plccopilot/cli", got ${JSON.stringify(pkg.name)}`);
}

// Sprint 60 — package must not be private; runtime deps must not use
// the workspace protocol. `npm pack` keeps both fields verbatim, so a
// regression here would silently ship an unpublishable tarball.
if (pkg.private === true) {
  fail('package.json must not be private:true on a publish candidate.');
}
const FORBIDDEN_DEP_SECTIONS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
];
for (const section of FORBIDDEN_DEP_SECTIONS) {
  const block = pkg[section];
  if (!block || typeof block !== 'object') continue;
  for (const [name, range] of Object.entries(block)) {
    if (typeof range === 'string' && range.startsWith('workspace:')) {
      fail(
        `package.json ${section}["${name}"] uses workspace protocol "${range}"; npm pack does not rewrite this — replace with explicit semver before publish.`,
      );
    }
  }
}

if (!pkg.bin || typeof pkg.bin !== 'object' || !pkg.bin.plccopilot) {
  fail(`package.json bin.plccopilot is missing; got ${JSON.stringify(pkg.bin)}`);
}

const binPath = String(pkg.bin.plccopilot).replace(/^\.\//, '');
if (binPath !== 'dist/index.js') {
  fail(
    `package.json bin.plccopilot must resolve to dist/index.js, got ${JSON.stringify(
      pkg.bin.plccopilot,
    )}`,
  );
}

if (!Array.isArray(pkg.files)) {
  fail(`package.json files must be an array, got ${JSON.stringify(pkg.files)}`);
}

for (const required of ['dist', 'schemas']) {
  if (!pkg.files.includes(required)) {
    fail(`package.json files must include ${JSON.stringify(required)}, got ${JSON.stringify(pkg.files)}`);
  }
}

if (!pkg.exports || typeof pkg.exports !== 'object') {
  fail(`package.json exports must be an object, got ${JSON.stringify(pkg.exports)}`);
}

if (!('.' in pkg.exports)) {
  fail(`package.json exports must declare "."`);
}

for (const subpath of REQUIRED_SCHEMA_EXPORTS) {
  if (!(subpath in pkg.exports)) {
    fail(`package.json exports must declare ${JSON.stringify(subpath)}`);
  }
}

// Sprint 59: exports["."] must point at compiled dist (the workspace
// kept source as the export target through sprint 58; sprint 59 flipped
// to dist + types). Regression here would mean a package.json revert
// silently shipped source-pointing exports to consumers — fatal.
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
    `package.json exports["."].default must be "./dist/index.js", got ${JSON.stringify(rootDefault)}`,
  );
}
if (rootTypes !== './dist/index.d.ts') {
  fail(
    `package.json exports["."].types must be "./dist/index.d.ts", got ${JSON.stringify(rootTypes)}`,
  );
}
if (pkg.types !== './dist/index.d.ts') {
  fail(
    `package.json "types" must be "./dist/index.d.ts", got ${JSON.stringify(pkg.types)}`,
  );
}

// ---------------------------------------------------------------------------
// 2. npm pack --dry-run --json
// ---------------------------------------------------------------------------

const npmResult = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: CLI_ROOT,
  encoding: 'utf-8',
  // Node 24 blocks direct .cmd execution on Windows (EINVAL); shell:true
  // is the official workaround. Args above are literal strings only.
  shell: process.platform === 'win32',
});

if (npmResult.error) {
  fail(`spawning npm pack failed: ${npmResult.error.message}`);
}

if (npmResult.status !== 0) {
  fail(
    `npm pack --dry-run exited ${npmResult.status}\n` +
      `  stdout: ${truncate(npmResult.stdout)}\n` +
      `  stderr: ${truncate(npmResult.stderr)}`,
  );
}

let manifest;
try {
  // npm prints clean JSON to stdout for --json. Some npm versions can
  // emit a leading warning line; if parsing fails, retry from the first
  // '[' to be defensive without papering over real noise.
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
    `cannot parse npm pack JSON: ${e instanceof Error ? e.message : String(e)}\n` +
      `  stdout: ${truncate(npmResult.stdout)}\n` +
      `  stderr: ${truncate(npmResult.stderr)}`,
  );
}

if (!Array.isArray(manifest) || manifest.length === 0) {
  fail(`npm pack JSON must be a non-empty array; got ${truncate(JSON.stringify(manifest))}`);
}

const entry = manifest[0];
if (!entry || typeof entry !== 'object' || !Array.isArray(entry.files)) {
  fail(`npm pack JSON entry has no files[]: ${truncate(JSON.stringify(entry))}`);
}

if (entry.name !== '@plccopilot/cli') {
  fail(`npm pack reports name=${JSON.stringify(entry.name)} (expected @plccopilot/cli)`);
}

// Normalise file paths to forward slashes — npm uses `/` everywhere
// but be defensive in case a future Windows npm leaks backslashes.
const packedPaths = entry.files
  .map((f) => (typeof f === 'object' && f && typeof f.path === 'string' ? f.path : null))
  .filter((p) => typeof p === 'string')
  .map((p) => p.replace(/\\/g, '/'));

if (packedPaths.length !== entry.files.length) {
  fail(
    `npm pack JSON has files without a string path: ${truncate(
      JSON.stringify(entry.files),
    )}`,
  );
}

const packedSet = new Set(packedPaths);

// ---------------------------------------------------------------------------
// 3. required entries
// ---------------------------------------------------------------------------

for (const required of REQUIRED_ENTRIES) {
  if (!packedSet.has(required)) {
    fail(`pack is missing required entry ${JSON.stringify(required)}`);
  }
}

// ---------------------------------------------------------------------------
// 4. forbidden entries
// ---------------------------------------------------------------------------

for (const path of packedPaths) {
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (path.startsWith(prefix)) {
      fail(`pack contains forbidden entry ${JSON.stringify(path)} (prefix ${JSON.stringify(prefix)})`);
    }
  }
  for (const exact of FORBIDDEN_EXACT) {
    if (path === exact) {
      fail(`pack contains forbidden file ${JSON.stringify(path)}`);
    }
  }
  for (const suffix of FORBIDDEN_SUFFIXES) {
    if (path.endsWith(suffix)) {
      fail(`pack contains forbidden file ${JSON.stringify(path)} (suffix ${JSON.stringify(suffix)})`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. exact schema set
// ---------------------------------------------------------------------------

const packedSchemas = packedPaths.filter((p) => p.startsWith('schemas/'));
const packedSchemaSet = new Set(packedSchemas);

for (const expected of EXPECTED_SCHEMA_SET) {
  if (!packedSchemaSet.has(expected)) {
    fail(`pack is missing expected schema ${JSON.stringify(expected)}`);
  }
}

for (const actual of packedSchemaSet) {
  if (!EXPECTED_SCHEMA_SET.has(actual)) {
    fail(
      `pack contains unexpected schema ${JSON.stringify(actual)} ` +
        '(update EXPECTED_SCHEMA_SET in scripts/smoke-cli-pack.mjs if intentional)',
    );
  }
}

// ---------------------------------------------------------------------------
// 6. summary
// ---------------------------------------------------------------------------

console.log(
  `CLI pack smoke passed. (${entry.entryCount ?? packedPaths.length} entries, ${
    packedSchemaSet.size
  } schemas, ${warnCount} warnings)`,
);
