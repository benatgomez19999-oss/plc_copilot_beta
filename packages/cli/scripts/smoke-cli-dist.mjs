#!/usr/bin/env node
/**
 * Sprint 53 — post-build smoke test for the compiled CLI binary.
 *
 * Goal: prove that `packages/cli/dist/index.js` actually starts under
 * Node and answers the small handful of commands integrators rely
 * on. Lives outside Vitest because the test is "the binary works on
 * a clean Node process" — running it inside the test runner would
 * just re-exercise the source TS that the suite already covers.
 *
 * Pre-requisite: `pnpm cli:build` has produced `dist/index.js`.
 *
 * Exit codes:
 *   0 — every smoke check passed
 *   1 — any check failed (logs to stderr; stdout stays terse)
 *
 * Dependencies: Node built-ins only (`child_process`, `fs`, `path`,
 * `url`). No new monorepo deps for this sprint.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(CLI_ROOT, '..', '..');
const DIST_BIN = resolve(CLI_ROOT, 'dist', 'index.js');
const FIXTURE = resolve(
  REPO_ROOT,
  'packages',
  'pir',
  'src',
  'fixtures',
  'weldline.json',
);
const SCHEMAS_DIR = resolve(REPO_ROOT, 'packages', 'cli', 'schemas');

function fail(message) {
  console.error(`smoke FAILED: ${message}`);
  process.exit(1);
}

function run(args) {
  const result = spawnSync(process.execPath, [DIST_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return result;
}

function expectExit(result, expectedCode, label) {
  if (result.status !== expectedCode) {
    fail(
      `${label}: expected exit ${expectedCode}, got ${result.status}\n` +
        `  stdout: ${truncate(result.stdout)}\n` +
        `  stderr: ${truncate(result.stderr)}`,
    );
  }
}

function expectIncludes(text, needle, label) {
  if (typeof text !== 'string' || !text.includes(needle)) {
    fail(
      `${label}: expected output to include ${JSON.stringify(needle)}\n` +
        `  got: ${truncate(text ?? '<missing>')}`,
    );
  }
}

function expectStderrEmpty(result, label) {
  if (typeof result.stderr === 'string' && result.stderr.length > 0) {
    fail(
      `${label}: expected empty stderr, got ${truncate(result.stderr)}`,
    );
  }
}

function parseStdoutJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    fail(
      `${label}: stdout was not parseable JSON\n` +
        `  parse error: ${e instanceof Error ? e.message : String(e)}\n` +
        `  stdout: ${truncate(result.stdout)}`,
    );
    return undefined; // unreachable
  }
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
      "Run 'pnpm cli:build' before invoking smoke.",
  );
}

// ---------------------------------------------------------------------------
// 1. help
// ---------------------------------------------------------------------------

{
  const r = run(['help']);
  expectExit(r, 0, 'help');
  expectIncludes(r.stdout, 'plccopilot', 'help: brand');
  expectIncludes(r.stdout, 'Usage:', 'help: usage banner');
  expectIncludes(r.stdout, 'schema', 'help: schema subcommand');
  expectIncludes(r.stdout, '--json', 'help: --json flag');
}

// ---------------------------------------------------------------------------
// 2. schema --name serialized-compiler-error parses + has expected $id
// ---------------------------------------------------------------------------

{
  const r = run(['schema', '--name', 'serialized-compiler-error']);
  expectExit(r, 0, 'schema serialized-compiler-error');
  expectStderrEmpty(r, 'schema serialized-compiler-error');
  const schema = parseStdoutJson(r, 'schema serialized-compiler-error');
  if (
    schema.$id !==
    'https://plccopilot.dev/schemas/serialized-compiler-error.schema.json'
  ) {
    fail(
      `schema serialized-compiler-error: unexpected $id ${JSON.stringify(
        schema.$id,
      )}`,
    );
  }
  if (
    !Array.isArray(schema.required) ||
    !schema.required.includes('name') ||
    !schema.required.includes('message')
  ) {
    fail(
      `schema serialized-compiler-error: required must include name+message, got ${JSON.stringify(
        schema.required,
      )}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. schema --check on the committed snapshot
// ---------------------------------------------------------------------------

{
  const r = run(['schema', '--check', SCHEMAS_DIR]);
  expectExit(r, 0, 'schema --check');
  expectStderrEmpty(r, 'schema --check');
  expectIncludes(r.stdout, 'Schema files are in sync', 'schema --check');
}

// ---------------------------------------------------------------------------
// 4. unknown command --json → structured error envelope, empty stderr
// ---------------------------------------------------------------------------

{
  const r = run(['totally-unknown', '--json']);
  expectExit(r, 1, 'unknown command --json');
  expectStderrEmpty(r, 'unknown command --json');
  const payload = parseStdoutJson(r, 'unknown command --json');
  if (payload.ok !== false) {
    fail(`unknown command --json: ok must be false, got ${payload.ok}`);
  }
  if (payload.command !== 'unknown') {
    fail(
      `unknown command --json: command must be "unknown", got ${JSON.stringify(
        payload.command,
      )}`,
    );
  }
  if (
    typeof payload.error?.message !== 'string' ||
    !payload.error.message.includes('unknown command')
  ) {
    fail(
      `unknown command --json: error.message must mention "unknown command"; got ${JSON.stringify(
        payload.error?.message,
      )}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. inspect --json on the weldline fixture
// ---------------------------------------------------------------------------

{
  const r = run(['inspect', '--input', FIXTURE, '--json']);
  expectExit(r, 0, 'inspect --json');
  expectStderrEmpty(r, 'inspect --json');
  const payload = parseStdoutJson(r, 'inspect --json');
  if (payload.ok !== true) {
    fail(`inspect --json: ok must be true, got ${payload.ok}`);
  }
  if (payload.command !== 'inspect') {
    fail(
      `inspect --json: command must be "inspect", got ${JSON.stringify(
        payload.command,
      )}`,
    );
  }
  if (payload.project?.id !== 'prj_weldline') {
    fail(
      `inspect --json: project.id must be "prj_weldline", got ${JSON.stringify(
        payload.project?.id,
      )}`,
    );
  }
  if (payload.counts?.machines !== 1) {
    fail(
      `inspect --json: counts.machines must be 1, got ${JSON.stringify(
        payload.counts?.machines,
      )}`,
    );
  }
}

console.log('CLI dist smoke passed.');
