#!/usr/bin/env node
// Sprint 65 — `pnpm release:provenance`.
//
// Local-only stub: confirms the publish path is *configured* to mint
// provenance attestations (publish workflow has `id-token: write` and
// references `--provenance`; the release-publish-real argv builder
// still hardcodes `--provenance`). It does NOT pull attestation
// bundles from the npm registry — that is a future sprint.
//
// Modes:
//   pnpm release:provenance                # use workspace shared version
//   pnpm release:provenance --version X.Y.Z
//   pnpm release:provenance --json
//   pnpm release:provenance --help

process.noDeprecation = true;

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadReleaseWorkspace } from './release-plan-lib.mjs';
import {
  buildProvenanceStubReport,
  checkPublishCommandProvenance,
  checkPublishWorkflowProvenance,
  parseProvenanceArgs,
} from './verify-provenance-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const PUBLISH_WORKFLOW_PATH = resolve(REPO_ROOT, '.github', 'workflows', 'publish.yml');

function reportIssues(issues) {
  for (const i of issues) {
    process.stderr.write(`error: ${i.code}: ${i.message}\n`);
    if (i.recommendation) process.stderr.write(`  fix: ${i.recommendation}\n`);
  }
}

const parsed = parseProvenanceArgs(process.argv.slice(2));
if (parsed.errors.length > 0) {
  reportIssues(parsed.errors);
  process.exit(1);
}
const options = parsed.options ?? {};
if (options.help) {
  process.stdout.write(`pnpm release:provenance [--version X.Y.Z] [--json]

Sprint 65 stub. Verifies that:
  - .github/workflows/publish.yml grants \`id-token: write\` and references --provenance
  - release-publish-real-lib#buildNpmPublishCommand still emits --provenance for every tag
  - the same argv never includes --dry-run

Does NOT pull attestation bundles from the npm registry (future sprint).
`);
  process.exit(0);
}

// Default version: shared workspace version (informational only — the
// stub does not contact the registry, but consumers want to see the
// version that *would* be verified).
let version = options.version;
if (!version) {
  const workspace = loadReleaseWorkspace(REPO_ROOT);
  const seen = new Set();
  for (const c of workspace.candidates) {
    if (c.missing || !c.pkg) continue;
    const v = c.pkg.parsed?.version;
    if (typeof v === 'string') seen.add(v);
  }
  if (seen.size === 1) version = [...seen][0];
}

let workflowText = '';
if (existsSync(PUBLISH_WORKFLOW_PATH)) {
  try {
    workflowText = readFileSync(PUBLISH_WORKFLOW_PATH, 'utf-8');
  } catch (e) {
    workflowText = '';
  }
}

const workflowIssues = checkPublishWorkflowProvenance({ workflowText });
const commandIssues = checkPublishCommandProvenance();
const report = buildProvenanceStubReport({
  version: version ?? null,
  workflowIssues,
  commandIssues,
});

if (options.json) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.ok ? 0 : 1);
}

if (!report.ok) {
  reportIssues(report.issues);
  process.stderr.write(
    `\nProvenance stub FAILED: ${report.issues.length} issue(s). ${report.note}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Provenance verification stub passed. ` +
    `(version ${report.version ?? '<unknown>'}, ` +
    `workflow id-token: ${report.checks.workflow_id_token_write ? 'ok' : 'missing'}, ` +
    `workflow --provenance: ${report.checks.workflow_provenance_flag ? 'ok' : 'missing'}, ` +
    `command --provenance: ${report.checks.command_provenance_flag ? 'ok' : 'missing'}, ` +
    `command no --dry-run: ${report.checks.command_no_dry_run ? 'ok' : 'broken'})\n` +
    `Note: ${report.note}\n`,
);
process.exit(0);
