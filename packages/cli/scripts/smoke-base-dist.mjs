#!/usr/bin/env node
/**
 * Sprint 57 — base package dist smoke for `@plccopilot/pir` and
 * `@plccopilot/codegen-core`.
 *
 * Pre-requisite: `pnpm build:packages-base`.
 *
 * What this proves:
 *   - Each package emitted `dist/index.js` AND `dist/index.d.ts`.
 *   - dist/ does not contain test/spec/fixture/tsbuildinfo junk.
 *   - Emitted .js files do not reference sibling `src/` paths
 *     (cross-package imports stay as bare `@plccopilot/*` specifiers
 *     so a real consumer would resolve them via node_modules, not via
 *     a TypeScript source path).
 *   - The dist `index.js` actually imports under Node and exposes the
 *     known runtime surface (`ProjectSchema` / `validate` for pir;
 *     `stableJson` / `CodegenError` / `serializeCompilerError` for
 *     codegen-core).
 *   - A small functional check: parse the weldline fixture with
 *     pir's `ProjectSchema`, then exercise `stableJson` and
 *     `serializeCompilerError` from the dist of codegen-core.
 *
 * Out of scope (Sprint 59 / 60 will pick these up):
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
const PIR_ROOT = resolve(REPO_ROOT, 'packages', 'pir');
const CORE_ROOT = resolve(REPO_ROOT, 'packages', 'codegen-core');
const PIR_DIST = resolve(PIR_ROOT, 'dist');
const CORE_DIST = resolve(CORE_ROOT, 'dist');
const PIR_DIST_INDEX_JS = resolve(PIR_DIST, 'index.js');
const PIR_DIST_INDEX_DTS = resolve(PIR_DIST, 'index.d.ts');
const CORE_DIST_INDEX_JS = resolve(CORE_DIST, 'index.js');
const CORE_DIST_INDEX_DTS = resolve(CORE_DIST, 'index.d.ts');
const WELDLINE_FIXTURE = resolve(
  PIR_ROOT,
  'src',
  'fixtures',
  'weldline.json',
);

function fail(message) {
  console.error(`Base package dist smoke FAILED: ${message}`);
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

// ---------------------------------------------------------------------------
// 0. dist files exist
// ---------------------------------------------------------------------------

const required = [
  ['@plccopilot/pir', PIR_DIST_INDEX_JS],
  ['@plccopilot/pir', PIR_DIST_INDEX_DTS],
  ['@plccopilot/codegen-core', CORE_DIST_INDEX_JS],
  ['@plccopilot/codegen-core', CORE_DIST_INDEX_DTS],
];
for (const [pkgName, file] of required) {
  if (!existsSync(file)) {
    fail(
      `${pkgName}: ${relative(REPO_ROOT, file)} missing.\n` +
        "Run 'pnpm build:packages-base' first.",
    );
  }
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

for (const [label, root] of [
  ['@plccopilot/pir', PIR_ROOT],
  ['@plccopilot/codegen-core', CORE_ROOT],
]) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
  } catch (e) {
    fail(`${label}: cannot read package.json (${e instanceof Error ? e.message : String(e)})`);
  }
  if (pkg.main !== './dist/index.js') {
    fail(`${label}: "main" must be "./dist/index.js", got ${JSON.stringify(pkg.main)}`);
  }
  if (pkg.types !== './dist/index.d.ts') {
    fail(`${label}: "types" must be "./dist/index.d.ts", got ${JSON.stringify(pkg.types)}`);
  }
  const targets = rootExportTargets(pkg.exports);
  if (targets.default !== './dist/index.js') {
    fail(
      `${label}: exports["."].default must be "./dist/index.js", got ${JSON.stringify(targets.default)}`,
    );
  }
  if (targets.types !== './dist/index.d.ts') {
    fail(
      `${label}: exports["."].types must be "./dist/index.d.ts", got ${JSON.stringify(targets.types)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. forbidden entries inside each dist tree
// ---------------------------------------------------------------------------

const FORBIDDEN_NAMES = new Set([
  'tsbuildinfo',
  '.tsbuildinfo',
  'vitest.config.js',
  'vitest.config.cjs',
]);
const FORBIDDEN_PREFIXES = ['tests/', 'src/', 'fixtures/'];
const FORBIDDEN_SUFFIXES = ['.spec.js', '.test.js', '.tsbuildinfo'];

for (const [label, root] of [
  ['pir', PIR_DIST],
  ['codegen-core', CORE_DIST],
]) {
  const files = listFiles(root);
  for (const f of files) {
    const rel = toPosix(relative(root, f));
    if (FORBIDDEN_NAMES.has(rel.toLowerCase())) {
      fail(`${label} dist contains forbidden file ${JSON.stringify(rel)}`);
    }
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (rel.startsWith(prefix)) {
        fail(
          `${label} dist contains forbidden entry ${JSON.stringify(rel)} ` +
            `(prefix ${JSON.stringify(prefix)})`,
        );
      }
    }
    for (const suffix of FORBIDDEN_SUFFIXES) {
      if (rel.endsWith(suffix)) {
        fail(
          `${label} dist contains forbidden file ${JSON.stringify(rel)} ` +
            `(suffix ${JSON.stringify(suffix)})`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. emitted .js files don't reference sibling source paths
//    (sourcemaps are excluded — they legitimately point back to src/).
// ---------------------------------------------------------------------------

const FORBIDDEN_JS_SUBSTRINGS = ['../pir/src', 'packages/pir/src', '/src/index.ts'];

for (const [label, root] of [
  ['pir', PIR_DIST],
  ['codegen-core', CORE_DIST],
]) {
  const jsFiles = listFiles(root).filter((f) => f.endsWith('.js'));
  for (const file of jsFiles) {
    const text = readFileSync(file, 'utf-8');
    for (const needle of FORBIDDEN_JS_SUBSTRINGS) {
      if (text.includes(needle)) {
        fail(
          `${label} dist file ${relative(REPO_ROOT, file)} references ${JSON.stringify(needle)} — sibling-source leak.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. dynamic import + runtime surface
// ---------------------------------------------------------------------------

const pir = await import(pathToFileURL(PIR_DIST_INDEX_JS).href);
for (const name of [
  'ProjectSchema',
  'validate',
  'tokenize',
  'analyzeExpression',
  'parseEquipmentRoleRef',
]) {
  if (!(name in pir)) {
    fail(`@plccopilot/pir dist missing runtime export ${JSON.stringify(name)}`);
  }
}
if (typeof pir.validate !== 'function') {
  fail('@plccopilot/pir: validate is not a function');
}
if (typeof pir.ProjectSchema?.parse !== 'function') {
  fail('@plccopilot/pir: ProjectSchema.parse is not a function');
}

let core;
try {
  core = await import(pathToFileURL(CORE_DIST_INDEX_JS).href);
} catch (e) {
  fail(
    `@plccopilot/codegen-core dist failed to import: ${
      e instanceof Error ? e.message : String(e)
    }`,
  );
}
for (const name of [
  'stableJson',
  'CodegenError',
  'serializeCompilerError',
  'formatSerializedCompilerError',
  'compileProject',
]) {
  if (!(name in core)) {
    fail(
      `@plccopilot/codegen-core dist missing runtime export ${JSON.stringify(name)}`,
    );
  }
}
if (typeof core.stableJson !== 'function') {
  fail('@plccopilot/codegen-core: stableJson is not a function');
}
if (typeof core.CodegenError !== 'function') {
  fail('@plccopilot/codegen-core: CodegenError is not a constructor');
}

// ---------------------------------------------------------------------------
// 4. functional smoke — parse fixture + serialize + stableJson
// ---------------------------------------------------------------------------

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
if (parsed.data?.id !== 'prj_weldline') {
  fail(
    `weldline fixture id mismatch: expected "prj_weldline", got ${JSON.stringify(parsed.data?.id)}`,
  );
}

// stableJson is `JSON.stringify(v, null, 2) + '\n'` — same input must
// produce a byte-identical string twice, and the trailing newline must
// be present (codegen-core relies on it for deterministic file writes).
const stableA = core.stableJson({ a: 1, b: 2 });
const stableB = core.stableJson({ a: 1, b: 2 });
if (stableA !== stableB) {
  fail(`codegen-core.stableJson is not deterministic across calls`);
}
if (!stableA.endsWith('\n')) {
  fail(
    `codegen-core.stableJson must end with a newline; got ${JSON.stringify(stableA)}`,
  );
}
if (!stableA.includes('"a": 1') || !stableA.includes('"b": 2')) {
  fail(
    `codegen-core.stableJson did not pretty-print 2-space indent: ${truncate(stableA)}`,
  );
}

// CodegenError + serializeCompilerError round-trip.
// Signature: new CodegenError(code, message, pathOrDetails?).
const err = new core.CodegenError(
  'CORE_TEST',
  'sprint-57 smoke',
  'machines[0]',
);
const serialized = core.serializeCompilerError(err);
if (
  !serialized ||
  typeof serialized !== 'object' ||
  serialized.name !== 'CodegenError' ||
  serialized.message !== 'sprint-57 smoke'
) {
  fail(
    `serializeCompilerError did not round-trip: ${truncate(JSON.stringify(serialized))}`,
  );
}
const formatted = core.formatSerializedCompilerError(serialized);
if (typeof formatted !== 'string' || !formatted.includes('sprint-57 smoke')) {
  fail(
    `formatSerializedCompilerError dropped the message: ${truncate(formatted)}`,
  );
}

// ---------------------------------------------------------------------------
// 5. summary
// ---------------------------------------------------------------------------

const pirCount = listFiles(PIR_DIST).length;
const coreCount = listFiles(CORE_DIST).length;
const pirDistSize = statSync(PIR_DIST_INDEX_JS).size;
const coreDistSize = statSync(CORE_DIST_INDEX_JS).size;

console.log(
  `Base package dist smoke passed. (pir: ${pirCount} files / index.js ${pirDistSize}B; codegen-core: ${coreCount} files / index.js ${coreDistSize}B)`,
);
