#!/usr/bin/env node
/**
 * Sprint 58 — vendor backend dist smoke for
 *   - @plccopilot/codegen-codesys
 *   - @plccopilot/codegen-rockwell
 *   - @plccopilot/codegen-siemens
 *
 * Pre-requisites:
 *   - `pnpm build:packages-base`   (pir + codegen-core dist)
 *   - `pnpm build:packages-vendor` (the three vendor builds in topo order)
 *
 * What this proves:
 *   - Each vendor emitted `dist/index.js` AND `dist/index.d.ts`.
 *   - dist/ does not contain test/spec/fixture/tsbuildinfo junk.
 *   - Emitted .js files do not embed sibling-source paths
 *     (`../pir/src`, `../codegen-core/src`, `/src/index.ts`, …) so
 *     cross-package imports stay as bare `@plccopilot/*` specifiers.
 *   - Each vendor dynamically imports under Node and exposes its
 *     façade function (`generateCodesysProject`,
 *     `generateRockwellProject`, `generateSiemensProject`).
 *   - A functional check parses the weldline fixture with
 *     `@plccopilot/pir`'s ProjectSchema and runs each vendor's
 *     façade — asserting it returns `GeneratedArtifact[]` with at
 *     least one path under the expected backend prefix.
 *
 * Out of scope (Sprints 59 / 60 will pick these up):
 *   - Flipping `exports["."]` from src to dist.
 *   - Dropping `private: true`.
 *   - Replacing `workspace:*` runtime ranges.
 *
 * Dependencies: Node built-ins only.
 */

process.noDeprecation = true;

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(CLI_ROOT, '..', '..');
const PACKAGES_ROOT = resolve(REPO_ROOT, 'packages');

const PIR_DIST_INDEX_JS = resolve(PACKAGES_ROOT, 'pir', 'dist', 'index.js');
const WELDLINE_FIXTURE = resolve(
  PACKAGES_ROOT,
  'pir',
  'src',
  'fixtures',
  'weldline.json',
);

/** @type {Array<{ pkg: string, dir: string, prefix: string, fn: string }>} */
const VENDORS = [
  {
    pkg: '@plccopilot/codegen-codesys',
    dir: 'codegen-codesys',
    prefix: 'codesys/',
    fn: 'generateCodesysProject',
  },
  {
    pkg: '@plccopilot/codegen-rockwell',
    dir: 'codegen-rockwell',
    prefix: 'rockwell/',
    fn: 'generateRockwellProject',
  },
  {
    pkg: '@plccopilot/codegen-siemens',
    dir: 'codegen-siemens',
    prefix: 'siemens/',
    fn: 'generateSiemensProject',
  },
];

function fail(message) {
  console.error(`Vendor package dist smoke FAILED: ${message}`);
  process.exit(1);
}

function truncate(s, max = 600) {
  if (typeof s !== 'string') return String(s);
  return s.length <= max ? s : `${s.slice(0, max)}…(truncated)`;
}

function listFiles(root) {
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

const FORBIDDEN_NAMES = new Set([
  'tsbuildinfo',
  '.tsbuildinfo',
  'vitest.config.js',
  'vitest.config.cjs',
]);
const FORBIDDEN_PREFIXES = ['tests/', 'src/', 'fixtures/'];
const FORBIDDEN_SUFFIXES = ['.spec.js', '.test.js', '.tsbuildinfo'];

const FORBIDDEN_JS_SUBSTRINGS = [
  '../pir/src',
  '../codegen-core/src',
  'packages/pir/src',
  'packages/codegen-core/src',
  '/src/index.ts',
];

// ---------------------------------------------------------------------------
// 0. dist files exist
// ---------------------------------------------------------------------------

if (!existsSync(PIR_DIST_INDEX_JS)) {
  fail(
    `@plccopilot/pir dist is missing — vendor smoke depends on it.\n` +
      "Run 'pnpm build:packages-base' first.",
  );
}

const distIndexes = {};
for (const v of VENDORS) {
  const distRoot = resolve(PACKAGES_ROOT, v.dir, 'dist');
  const indexJs = resolve(distRoot, 'index.js');
  const indexDts = resolve(distRoot, 'index.d.ts');
  if (!existsSync(indexJs) || !existsSync(indexDts)) {
    fail(
      `${v.pkg}: ${relative(REPO_ROOT, !existsSync(indexJs) ? indexJs : indexDts)} missing.\n` +
        "Run 'pnpm build:packages-vendor' first.",
    );
  }
  distIndexes[v.dir] = { distRoot, indexJs, indexDts };
}

// ---------------------------------------------------------------------------
// 0b. package.json metadata points at dist (sprint 59)
// ---------------------------------------------------------------------------

function rootExportTargets(exportsField) {
  if (!exportsField || typeof exportsField !== 'object') return {};
  const entry = exportsField['.'];
  if (typeof entry === 'string') return { default: entry };
  if (entry && typeof entry === 'object') {
    return {
      types: typeof entry.types === 'string' ? entry.types : undefined,
      default:
        typeof entry.default === 'string'
          ? entry.default
          : typeof entry.import === 'string'
            ? entry.import
            : typeof entry.require === 'string'
              ? entry.require
              : undefined,
    };
  }
  return {};
}

for (const v of VENDORS) {
  const pkgPath = resolve(PACKAGES_ROOT, v.dir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch (e) {
    fail(`${v.pkg}: cannot read package.json (${e instanceof Error ? e.message : String(e)})`);
  }
  if (pkg.main !== './dist/index.js') {
    fail(`${v.pkg}: "main" must be "./dist/index.js", got ${JSON.stringify(pkg.main)}`);
  }
  if (pkg.types !== './dist/index.d.ts') {
    fail(`${v.pkg}: "types" must be "./dist/index.d.ts", got ${JSON.stringify(pkg.types)}`);
  }
  const targets = rootExportTargets(pkg.exports);
  if (targets.default !== './dist/index.js') {
    fail(
      `${v.pkg}: exports["."].default must be "./dist/index.js", got ${JSON.stringify(targets.default)}`,
    );
  }
  if (targets.types !== './dist/index.d.ts') {
    fail(
      `${v.pkg}: exports["."].types must be "./dist/index.d.ts", got ${JSON.stringify(targets.types)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. forbidden entries inside each vendor dist
// ---------------------------------------------------------------------------

for (const v of VENDORS) {
  const root = distIndexes[v.dir].distRoot;
  for (const f of listFiles(root)) {
    const rel = toPosix(relative(root, f));
    if (FORBIDDEN_NAMES.has(rel.toLowerCase())) {
      fail(`${v.pkg} dist contains forbidden file ${JSON.stringify(rel)}`);
    }
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (rel.startsWith(prefix)) {
        fail(
          `${v.pkg} dist contains forbidden entry ${JSON.stringify(rel)} ` +
            `(prefix ${JSON.stringify(prefix)})`,
        );
      }
    }
    for (const suffix of FORBIDDEN_SUFFIXES) {
      if (rel.endsWith(suffix)) {
        fail(
          `${v.pkg} dist contains forbidden file ${JSON.stringify(rel)} ` +
            `(suffix ${JSON.stringify(suffix)})`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. emitted .js must not embed sibling-source paths (sourcemaps excluded)
// ---------------------------------------------------------------------------

for (const v of VENDORS) {
  const jsFiles = listFiles(distIndexes[v.dir].distRoot).filter((f) =>
    f.endsWith('.js'),
  );
  for (const file of jsFiles) {
    const text = readFileSync(file, 'utf-8');
    for (const needle of FORBIDDEN_JS_SUBSTRINGS) {
      if (text.includes(needle)) {
        fail(
          `${v.pkg} dist file ${relative(REPO_ROOT, file)} references ${JSON.stringify(needle)} — sibling-source leak.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. dynamic import + façade present
// ---------------------------------------------------------------------------

const modules = {};
for (const v of VENDORS) {
  let mod;
  try {
    mod = await import(pathToFileURL(distIndexes[v.dir].indexJs).href);
  } catch (e) {
    fail(
      `${v.pkg} dist failed to import: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (typeof mod[v.fn] !== 'function') {
    fail(
      `${v.pkg} dist is missing façade ${JSON.stringify(v.fn)} (or it is not a function).`,
    );
  }
  modules[v.dir] = mod;
}

// ---------------------------------------------------------------------------
// 4. functional smoke — parse weldline + run each façade
// ---------------------------------------------------------------------------

let pir;
try {
  pir = await import(pathToFileURL(PIR_DIST_INDEX_JS).href);
} catch (e) {
  fail(
    `cannot import @plccopilot/pir dist: ${
      e instanceof Error ? e.message : String(e)
    }`,
  );
}

let weldlineRaw;
try {
  weldlineRaw = JSON.parse(readFileSync(WELDLINE_FIXTURE, 'utf-8'));
} catch (e) {
  fail(
    `cannot read weldline fixture ${WELDLINE_FIXTURE}: ${
      e instanceof Error ? e.message : String(e)
    }`,
  );
}

const parsed = pir.ProjectSchema.safeParse(weldlineRaw);
if (!parsed.success) {
  fail(
    `pir.ProjectSchema.safeParse rejected the weldline fixture: ${truncate(
      JSON.stringify(parsed.error?.issues ?? parsed.error),
    )}`,
  );
}
const project = parsed.data;

const opts = { manifest: { generatedAt: '2026-01-01T00:00:00.000Z' } };

for (const v of VENDORS) {
  let result;
  try {
    result = modules[v.dir][v.fn](project, opts);
  } catch (e) {
    fail(
      `${v.pkg}.${v.fn}() threw: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const artifacts = Array.isArray(result) ? result : result?.artifacts;
  if (!Array.isArray(artifacts)) {
    fail(
      `${v.pkg}.${v.fn}() must return GeneratedArtifact[] (or { artifacts }); got ${truncate(
        JSON.stringify(result),
      )}`,
    );
  }
  if (artifacts.length === 0) {
    fail(`${v.pkg}.${v.fn}() returned an empty artifacts array`);
  }
  if (
    !artifacts.some(
      (a) => typeof a?.path === 'string' && a.path.startsWith(v.prefix),
    )
  ) {
    const sample = artifacts
      .slice(0, 5)
      .map((a) => a?.path)
      .filter(Boolean)
      .join(', ');
    fail(
      `${v.pkg}.${v.fn}() produced no artifact under ${JSON.stringify(v.prefix)}; sample paths: ${sample}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. summary
// ---------------------------------------------------------------------------

const counts = VENDORS.map((v) => {
  const files = listFiles(distIndexes[v.dir].distRoot).length;
  const size = statSync(distIndexes[v.dir].indexJs).size;
  return `${v.dir.replace(/^codegen-/, '')}: ${files} files / index.js ${size}B`;
}).join('; ');

console.log(`Vendor package dist smoke passed. (${counts})`);
