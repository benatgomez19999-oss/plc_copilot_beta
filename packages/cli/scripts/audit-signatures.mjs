#!/usr/bin/env node
// Sprint 71 — `pnpm release:audit-signatures`.
//
// Wraps `npm audit signatures` against an already-published
// @plccopilot/* version. Empirically (verified 2026-04-28 with npm
// 11.11.0), this command verifies BOTH:
//   - npm registry package signatures
//   - npm provenance attestations (slsa.dev/provenance/v1)
//
// for every installed package in the consumer graph. Honest scope:
// it does NOT validate the in-toto attestation *claims* against
// expected GitHub repo / workflow / git commit (that's what Sprint
// 70's `release:provenance --metadata-only` does), and it does NOT
// implement custom Sigstore Fulcio chain walks. It is the npm CLI's
// authoritative cryptographic check.
//
// What it does:
//   1. Make a fresh temp consumer project under `os.tmpdir()`.
//   2. `npm install --ignore-scripts --no-audit --no-fund
//      --registry <url> @plccopilot/cli@<version>` (default package).
//   3. `npm audit signatures --json` in the temp dir.
//   4. Parse the JSON (`{ invalid: [], missing: [] }`) and pass iff
//      both arrays are empty AND exit-code is 0.
//   5. Cleanup the temp dir unless `--keep` or
//      `PLC_COPILOT_KEEP_SIGNATURE_SMOKE=1` is set.
//
// Hard invariants:
//   - No `npm publish` / `npm dist-tag` argv ever spawned.
//   - `assertNoNpmMutationSurfaceAuditSignatures` is called before
//     every spawn.
//   - The runner exits 1 on any audit-signatures failure (non-zero,
//     unsupported, signature mismatch, missing) — no greenwashing.

process.noDeprecation = true;

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadReleaseWorkspace } from './release-plan-lib.mjs';
import {
  AUDIT_SIGNATURES_DEFAULTS,
  assertNoNpmMutationSurfaceAuditSignatures,
  buildAuditSignaturesReport,
  buildNpmAuditSignaturesArgs,
  buildNpmInstallArgs,
  isNoSignaturesFound,
  isNpmAuditSignaturesUnsupported,
  isPackageNotFoundError,
  isSignatureFailure,
  parseAuditSignaturesArgs,
  parseAuditSignaturesJson,
  summarizeSpawnFailure,
  validateAuditSignaturesOptions,
} from './audit-signatures-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

function reportIssues(issues, stream = process.stderr) {
  for (const i of issues) {
    const lvl = i.level ?? 'error';
    stream.write(`${lvl}: ${i.code}: ${i.message}\n`);
    if (i.recommendation) stream.write(`  fix: ${i.recommendation}\n`);
  }
}

function spawnNpm(args, cwd) {
  assertNoNpmMutationSurfaceAuditSignatures(args);
  return spawnSync('npm', [...args], {
    cwd,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
}

const parsed = parseAuditSignaturesArgs(process.argv.slice(2));
if (parsed.errors.length > 0) {
  reportIssues(parsed.errors);
  process.exit(1);
}
const rawOptions = parsed.options ?? {};

if (rawOptions.help) {
  process.stdout.write(`pnpm release:audit-signatures --version X.Y.Z [--registry URL] [--package @plccopilot/<name>] [--json] [--keep]

Wraps \`npm audit signatures\` against an already-published @plccopilot
version. Installs the package into a fresh temp consumer project, runs
\`npm audit signatures --json\`, and reports the result. NEVER mutates
npm. NEVER requires NPM_TOKEN.

Default --package is @plccopilot/cli (it pulls the full internal
dependency graph, so every @plccopilot/* package is audited).

What it verifies (delegated to npm CLI):
  - npm registry package signatures
  - npm provenance attestations

What it does NOT verify (other tools):
  - in-toto attestation *claims* against expected GitHub repo + workflow
    (Sprint 70 \`release:provenance --metadata-only\`)
  - custom Sigstore Fulcio chain walk + Rekor inclusion proof (still
    future work)

Environment overrides:
  PLC_COPILOT_KEEP_SIGNATURE_SMOKE=1   keep the temp dir for inspection
`);
  process.exit(0);
}

let workspace = null;
try {
  workspace = loadReleaseWorkspace(REPO_ROOT);
} catch {
  workspace = null;
}

const { options, issues: optionIssues } = validateAuditSignaturesOptions(
  rawOptions,
  workspace,
);
if (optionIssues.length > 0) {
  reportIssues(optionIssues);
  process.exit(1);
}

const keep =
  options.keep === true ||
  process.env.PLC_COPILOT_KEEP_SIGNATURE_SMOKE === '1' ||
  process.env.PLC_COPILOT_KEEP_SIGNATURE_SMOKE === 'true';

// -----------------------------------------------------------------------
// Temp consumer project
// -----------------------------------------------------------------------

const tempDir = mkdtempSync(`${tmpdir()}${sep}plccopilot-audit-signatures-`);
const installIssues = [];
const auditIssues = [];

let installResult = null;
let auditResult = null;
let auditJson = null;

try {
  // Minimal consumer package.json — `npm install` requires *some* file.
  writeFileSync(
    resolve(tempDir, 'package.json'),
    JSON.stringify(
      {
        name: 'plccopilot-audit-signatures-consumer',
        version: '0.0.0',
        private: true,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  // Pre-create node_modules to avoid npm warnings on Windows.
  mkdirSync(resolve(tempDir, 'node_modules'), { recursive: true });

  // Install the requested @plccopilot/* package.
  const installArgs = buildNpmInstallArgs({
    packageName: options.packageName,
    version: options.version,
    registry: options.registry,
  });
  process.stderr.write(
    `release-audit-signatures: installing ${options.packageName}@${options.version} from ${options.registry} into ${tempDir}\n`,
  );
  installResult = spawnNpm(installArgs, tempDir);

  if (installResult.error) {
    installIssues.push({
      level: 'error',
      code: 'AUDIT_SIGNATURES_SPAWN_FAILED',
      message: `spawning npm install failed: ${installResult.error.message}`,
      recommendation: 'Confirm `npm` is on PATH and the registry is reachable.',
    });
  } else if (installResult.status !== 0) {
    if (isPackageNotFoundError(installResult.stderr, installResult.stdout)) {
      installIssues.push({
        level: 'error',
        code: 'AUDIT_SIGNATURES_PACKAGE_NOT_FOUND',
        message: `${options.packageName}@${options.version} could not be resolved on ${options.registry}.`,
        recommendation:
          'Confirm the version is published. See `pnpm release:npm-view --version <v> --tag latest`.',
      });
    } else {
      installIssues.push({
        level: 'error',
        code: 'AUDIT_SIGNATURES_INSTALL_FAILED',
        message: `npm install ${options.packageName}@${options.version} exited ${installResult.status}.`,
        recommendation: null,
      });
    }
  } else {
    // -------------------------------------------------------------------
    // npm audit signatures
    // -------------------------------------------------------------------
    const auditArgs = buildNpmAuditSignaturesArgs({ json: true });
    process.stderr.write(`release-audit-signatures: running \`npm audit signatures --json\`\n`);
    auditResult = spawnNpm(auditArgs, tempDir);

    if (auditResult.error) {
      auditIssues.push({
        level: 'error',
        code: 'AUDIT_SIGNATURES_SPAWN_FAILED',
        message: `spawning npm audit signatures failed: ${auditResult.error.message}`,
        recommendation: null,
      });
    } else {
      // Detect "command unsupported" first (would also produce a
      // non-zero exit; the friendlier message takes precedence).
      if (isNpmAuditSignaturesUnsupported(auditResult.stderr, auditResult.stdout)) {
        auditIssues.push({
          level: 'error',
          code: 'AUDIT_SIGNATURES_COMMAND_UNSUPPORTED',
          message:
            '`npm audit signatures` is not supported by this npm version.',
          recommendation:
            'Upgrade to npm 9.5.0 or later (audit-signatures was added in npm 8.x but stabilised later).',
        });
      } else if (isNoSignaturesFound(auditResult.stderr, auditResult.stdout)) {
        auditIssues.push({
          level: 'error',
          code: 'AUDIT_SIGNATURES_NO_SIGNATURES',
          message:
            'npm reported no verifiable signatures available for the installed graph.',
          recommendation:
            'The registry may not expose signatures, or the packages were published without provenance.',
        });
      } else if (isSignatureFailure(auditResult.stderr, auditResult.stdout)) {
        auditIssues.push({
          level: 'error',
          code: 'AUDIT_SIGNATURES_SIGNATURE_FAILED',
          message:
            'npm reported a signature mismatch for at least one installed package.',
          recommendation:
            'Inspect the install graph in the temp dir (--keep) and the audit stdout for details.',
        });
      } else if (auditResult.status !== 0) {
        auditIssues.push({
          level: 'error',
          code: 'AUDIT_SIGNATURES_NONZERO',
          message: `npm audit signatures exited ${auditResult.status}.`,
          recommendation:
            'Re-run with --keep to inspect the temp dir and stdout.',
        });
      }
      auditJson = parseAuditSignaturesJson(auditResult.stdout);
      // Also surface a structured failure if invalid[] / missing[]
      // are non-empty even when exit code is 0 — defence in depth.
      if (auditJson && Array.isArray(auditJson.invalid) && auditJson.invalid.length > 0) {
        auditIssues.push({
          level: 'error',
          code: 'AUDIT_SIGNATURES_SIGNATURE_FAILED',
          message: `audit reports ${auditJson.invalid.length} package(s) with invalid signatures/attestations.`,
          recommendation: null,
        });
      }
      if (auditJson && Array.isArray(auditJson.missing) && auditJson.missing.length > 0) {
        auditIssues.push({
          level: 'error',
          code: 'AUDIT_SIGNATURES_NO_SIGNATURES',
          message: `audit reports ${auditJson.missing.length} package(s) with missing signatures.`,
          recommendation: null,
        });
      }
    }
  }

  const report = buildAuditSignaturesReport({
    version: options.version,
    registry: options.registry,
    packageName: options.packageName,
    installResult,
    auditResult,
    auditJson,
    installIssues,
    auditIssues,
    tempDir,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (!report.ok) {
    reportIssues(report.issues);
    if (installResult && installIssues.length > 0) {
      const summary = summarizeSpawnFailure('install', installResult);
      process.stderr.write(
        `\ninstall failure summary:\n  ${JSON.stringify(summary)}\n`,
      );
    }
    if (auditResult && auditIssues.length > 0) {
      const summary = summarizeSpawnFailure('audit signatures', auditResult);
      process.stderr.write(
        `\naudit signatures failure summary:\n  ${JSON.stringify(summary)}\n`,
      );
    }
    process.stderr.write(
      `\nProvenance signature audit FAILED. (${report.issues.length} issue(s))\n` +
        `Note: ${report.note}\n`,
    );
  } else {
    const inv = report.audit_signatures.invalid_count;
    const mis = report.audit_signatures.missing_count;
    process.stdout.write(
      `npm audit signatures passed. ` +
        `(${options.packageName}@${options.version} installed from ${options.registry}; ` +
        `invalid=${inv === null ? '<unknown>' : inv}, missing=${mis === null ? '<unknown>' : mis})\n` +
        `Note: ${report.note}\n`,
    );
  }

  process.exit(report.ok ? 0 : 1);
} finally {
  if (!keep) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort — leaving the dir behind is harmless
    }
  } else {
    process.stderr.write(`release-audit-signatures: --keep set; temp dir retained at ${tempDir}\n`);
  }
}
