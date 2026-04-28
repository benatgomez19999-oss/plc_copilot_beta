#!/usr/bin/env node
// Sprint 65 + 70 — `pnpm release:provenance`.
//
// Three modes:
//
//   pnpm release:provenance --config-only [--version X.Y.Z] [--json]
//     Sprint 65 stub. Local-only configuration check — no network. Used
//     by the post-publish-verify workflow's first step (so a broken
//     publish path is caught before any registry call).
//
//   pnpm release:provenance --metadata-only --version X.Y.Z [--json]
//     Sprint 70 metadata path. Reads `npm view` for every release
//     candidate, fetches every package's npm-attestations endpoint,
//     decodes the DSSE envelope payload, and validates the in-toto
//     Statement claims (subject + workflow.repository + workflow.path
//     + recorded git commit) against the expected GitHub repo. NO npm
//     mutation. NO Sigstore cryptographic verification — the bundle
//     signature + Fulcio cert chain walk are NOT implemented and the
//     report says so explicitly.
//
//   pnpm release:provenance [--version X.Y.Z] [--json]
//     Default = config + metadata. Used by the manual `Verify
//     provenance` workflow. Falls back to config-only if `--version`
//     is not resolvable from the workspace (so a fresh CI run that
//     pre-dates first publish doesn't 404).
//
// Hard invariants:
//   - No `npm publish` / `npm dist-tag` argv ever spawned.
//     `assertNoNpmMutationSurfaceProvenance` is called against every
//     `npm view` argv before spawn.
//   - The runner exits 1 on any error-level issue; warnings (e.g.
//     `gitHead` not exposed by npm) do NOT fail the run.

process.noDeprecation = true;

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadReleaseWorkspace } from './release-plan-lib.mjs';
import {
  PROVENANCE_DEFAULT_REGISTRY,
  PROVENANCE_PACKAGE_ORDER,
  assertNoNpmMutationSurfaceProvenance,
  buildNpmViewPackageArgs,
  buildProvenanceReport,
  buildProvenanceStubReport,
  checkPublishCommandProvenance,
  checkPublishWorkflowProvenance,
  decodeDsseProvenancePayload,
  extractAttestationGitCommit,
  extractAttestationsBundle,
  parseNpmViewJson,
  parseProvenanceArgs,
  resolveProvenanceMode,
  validateAttestationClaims,
  validatePackageMetadataProvenance,
} from './verify-provenance-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const PUBLISH_WORKFLOW_PATH = resolve(REPO_ROOT, '.github', 'workflows', 'publish.yml');

function reportIssues(issues, stream = process.stderr) {
  for (const i of issues) {
    const lvl = i.level ?? 'error';
    stream.write(`${lvl}: ${i.code}: ${i.message}\n`);
    if (i.recommendation) stream.write(`  fix: ${i.recommendation}\n`);
  }
}

function truncate(s, max = 600) {
  if (typeof s !== 'string') return String(s);
  return s.length <= max ? s : `${s.slice(0, max)}…(truncated)`;
}

function spawnNpmView(args) {
  assertNoNpmMutationSurfaceProvenance(args);
  return spawnSync('npm', [...args], {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
}

const parsed = parseProvenanceArgs(process.argv.slice(2));
if (parsed.errors.length > 0) {
  reportIssues(parsed.errors);
  process.exit(1);
}
const options = parsed.options ?? {};
if (options.help) {
  process.stdout.write(`pnpm release:provenance [--version X.Y.Z] [--registry URL] [--json]
pnpm release:provenance --config-only [--version X.Y.Z] [--json]
pnpm release:provenance --metadata-only --version X.Y.Z [--registry URL] [--json]

Modes:
  default        config check + registry metadata + attestation claims
  --config-only  Sprint 65 stub: workflow + publish-command argv only
  --metadata-only registry-only: npm view + attestation claims for every package

Verifies:
  Sprint 65 stub  (--config-only / default):
    - .github/workflows/publish.yml grants \`id-token: write\`
    - .github/workflows/publish.yml references --provenance
    - release-publish-real argv builder still emits --provenance
    - that argv never includes --dry-run

  Sprint 70 metadata (--metadata-only / default):
    - npm view <pkg>@<version> --json returns the expected name + version
    - dist.integrity, dist.tarball, dist.attestations.url present
    - repository.url normalises to the expected GitHub repo
    - attestation endpoint returns parseable JSON
    - DSSE in-toto Statement subject matches pkg:npm/<scope>/<name>@<version>
    - in-toto predicate.workflow.repository matches expected GitHub repo
    - in-toto predicate.workflow.path matches .github/workflows/publish.yml

NOT verified:
  - cryptographic Sigstore bundle verification (Fulcio chain walk,
    Rekor inclusion proof, signature validation). The runner reads
    the bundle but does NOT validate its signature.

Package set:
  ${PROVENANCE_PACKAGE_ORDER.join('\n  ')}
`);
  process.exit(0);
}

let mode = resolveProvenanceMode(options);

// Resolve version. If not given, try the workspace's shared version.
let version = options.version;
if (!version) {
  try {
    const workspace = loadReleaseWorkspace(REPO_ROOT);
    const seen = new Set();
    for (const c of workspace.candidates) {
      if (c.missing || !c.pkg) continue;
      const v = c.pkg.parsed?.version;
      if (typeof v === 'string') seen.add(v);
    }
    if (seen.size === 1) version = [...seen][0];
  } catch {
    // Treat as unknown; --metadata-only will then fail with a clear
    // PROVENANCE_VERSION_REQUIRED issue.
  }
}

const registry =
  typeof options.registry === 'string' && /^https?:\/\//.test(options.registry)
    ? options.registry
    : PROVENANCE_DEFAULT_REGISTRY;

// ---------------------------------------------------------------------------
// Layer 1: configuration checks (config-only / default)
// ---------------------------------------------------------------------------

let configChecks = null;
if (mode === 'config-only' || mode === 'default') {
  let workflowText = '';
  if (existsSync(PUBLISH_WORKFLOW_PATH)) {
    try {
      workflowText = readFileSync(PUBLISH_WORKFLOW_PATH, 'utf-8');
    } catch {
      workflowText = '';
    }
  }
  const workflowIssues = checkPublishWorkflowProvenance({ workflowText });
  const commandIssues = checkPublishCommandProvenance();
  configChecks = {
    workflow_id_token_write: !workflowIssues.some(
      (i) => i.code === 'PROVENANCE_WORKFLOW_NO_ID_TOKEN',
    ),
    publish_command_provenance_flag: !commandIssues.some(
      (i) => i.code === 'PROVENANCE_COMMAND_NO_PROVENANCE',
    ),
    publish_command_no_dry_run: !commandIssues.some(
      (i) => i.code === 'PROVENANCE_COMMAND_DRY_RUN',
    ),
    issues: [...workflowIssues, ...commandIssues],
  };
}

// ---------------------------------------------------------------------------
// Layer 2 + 3: registry metadata + attestation claims (metadata-only / default)
// ---------------------------------------------------------------------------

let packageResults = null;
if (mode === 'metadata-only' || mode === 'default') {
  if (typeof version !== 'string' || version.length === 0) {
    if (mode === 'metadata-only') {
      reportIssues([
        {
          level: 'error',
          code: 'PROVENANCE_VERSION_REQUIRED',
          message: '--version is required for --metadata-only mode.',
          recommendation: 'Pass --version X.Y.Z (must equal a published version).',
        },
      ]);
      process.exit(1);
    }
    // Default mode + no version → degrade to config-only and emit a
    // single warning. This preserves Sprint 65 stub behaviour for a
    // workspace whose version is ambiguous.
    process.stderr.write(
      'release-provenance: no version resolved from workspace; running config-only.\n',
    );
    mode = 'config-only';
  } else {
    packageResults = [];
    for (const packageName of PROVENANCE_PACKAGE_ORDER) {
      const pkgIssues = [];
      const args = buildNpmViewPackageArgs({ packageName, version, registry });
      const result = spawnNpmView(args);
      if (result.error) {
        pkgIssues.push({
          level: 'error',
          code: 'PROVENANCE_NPM_VIEW_NONZERO',
          message: `spawning npm view for ${packageName}@${version} failed: ${result.error.message}`,
          recommendation: null,
        });
        packageResults.push({
          name: packageName,
          version,
          distIntegrity: false,
          tarball: false,
          attestations: null,
          issues: pkgIssues,
        });
        continue;
      }
      if (result.status !== 0) {
        pkgIssues.push({
          level: 'error',
          code: 'PROVENANCE_NPM_VIEW_NONZERO',
          message: `npm view ${packageName}@${version} exited ${result.status}.\n  stderr: ${truncate(result.stderr)}`,
          recommendation: null,
        });
        packageResults.push({
          name: packageName,
          version,
          distIntegrity: false,
          tarball: false,
          attestations: null,
          issues: pkgIssues,
        });
        continue;
      }
      const metadata = parseNpmViewJson(result.stdout);
      if (metadata === null || typeof metadata !== 'object') {
        pkgIssues.push({
          level: 'error',
          code: 'PROVENANCE_NPM_VIEW_PARSE_FAILED',
          message: `${packageName}: npm view stdout could not be parsed as JSON.`,
          recommendation: null,
        });
        packageResults.push({
          name: packageName,
          version,
          distIntegrity: false,
          tarball: false,
          attestations: null,
          issues: pkgIssues,
        });
        continue;
      }
      const metadataIssues = validatePackageMetadataProvenance(metadata, {
        packageName,
        version,
      });
      for (const i of metadataIssues) pkgIssues.push(i);

      const distIntegrity =
        typeof metadata.dist?.integrity === 'string' &&
        metadata.dist.integrity.length > 0;
      const tarball =
        typeof metadata.dist?.tarball === 'string' &&
        /^https?:\/\//.test(metadata.dist.tarball);
      const attestationsUrl = metadata.dist?.attestations?.url;

      // Fetch attestations bundle (if URL present) and validate claims.
      let claimsVerified = false;
      let predicateType = null;
      let workflowPath = null;
      let repositoryUrl = null;
      let gitCommit = null;
      if (typeof attestationsUrl === 'string' && /^https?:\/\//.test(attestationsUrl)) {
        let bundleResponse;
        try {
          bundleResponse = await fetch(attestationsUrl);
        } catch (e) {
          pkgIssues.push({
            level: 'error',
            code: 'PROVENANCE_ATTESTATION_FETCH_FAILED',
            message: `${packageName}: fetching ${attestationsUrl} failed: ${e instanceof Error ? e.message : String(e)}`,
            recommendation: null,
          });
        }
        if (bundleResponse) {
          if (!bundleResponse.ok) {
            pkgIssues.push({
              level: 'error',
              code: 'PROVENANCE_ATTESTATION_FETCH_FAILED',
              message: `${packageName}: attestations endpoint returned HTTP ${bundleResponse.status}.`,
              recommendation: null,
            });
          } else {
            let raw;
            try {
              raw = await bundleResponse.json();
            } catch (e) {
              pkgIssues.push({
                level: 'error',
                code: 'PROVENANCE_ATTESTATION_PARSE_FAILED',
                message: `${packageName}: attestations response was not JSON: ${e instanceof Error ? e.message : String(e)}`,
                recommendation: null,
              });
            }
            if (raw) {
              const split = extractAttestationsBundle(raw);
              for (const i of split.issues) pkgIssues.push(i);
              if (split.slsa) {
                const decoded = decodeDsseProvenancePayload(split.slsa);
                for (const i of decoded.issues) pkgIssues.push(i);
                if (decoded.statement) {
                  const claimIssues = validateAttestationClaims(decoded.statement, {
                    packageName,
                    version,
                  });
                  for (const i of claimIssues) pkgIssues.push(i);
                  predicateType = decoded.statement?.predicateType ?? null;
                  workflowPath =
                    decoded.statement?.predicate?.buildDefinition
                      ?.externalParameters?.workflow?.path ?? null;
                  repositoryUrl =
                    decoded.statement?.predicate?.buildDefinition
                      ?.externalParameters?.workflow?.repository ?? null;
                  gitCommit = extractAttestationGitCommit(decoded.statement);
                  claimsVerified =
                    claimIssues.filter((i) => i.level === 'error').length === 0;
                }
              }
            }
          }
        }
      }

      packageResults.push({
        name: packageName,
        version,
        distIntegrity,
        tarball,
        attestations: {
          present: typeof attestationsUrl === 'string' && attestationsUrl.length > 0,
          url: attestationsUrl ?? null,
          predicateType,
          workflowPath,
          repositoryUrl,
          gitCommit,
          claimsVerified,
        },
        issues: pkgIssues,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Build + emit report
// ---------------------------------------------------------------------------

const report = buildProvenanceReport({
  mode,
  version: version ?? null,
  registry,
  configChecks,
  packageResults,
});

if (options.json) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.ok ? 0 : 1);
}

if (!report.ok) {
  reportIssues(report.issues);
  process.stderr.write(
    `\nProvenance verification FAILED. (${report.issues.filter((i) => i.level === 'error').length} error(s)).\n` +
      `Note: ${report.note}\n`,
  );
  process.exit(1);
}

const warnings = report.issues.filter((i) => i.level === 'warning');
if (warnings.length > 0) {
  reportIssues(warnings, process.stdout);
}

if (mode === 'config-only') {
  process.stdout.write(
    `Provenance verification (config-only) passed. ` +
      `(version ${report.version ?? '<unknown>'}, ` +
      `workflow id-token: ${report.config?.workflow_id_token_write ? 'ok' : 'missing'}, ` +
      `publish --provenance: ${report.config?.publish_command_provenance_flag ? 'ok' : 'missing'}, ` +
      `publish no --dry-run: ${report.config?.publish_command_no_dry_run ? 'ok' : 'broken'})\n` +
      `Note: ${report.note}\n`,
  );
} else {
  const pkgCount = report.packages?.length ?? 0;
  const allWithAttestations =
    pkgCount > 0 && report.packages?.every((p) => p.attestations.present);
  const allClaimsVerified =
    pkgCount > 0 && report.packages?.every((p) => p.attestations.claims_verified);
  process.stdout.write(
    `Provenance verification passed. ` +
      `(${pkgCount} packages at ${report.version}; ` +
      `attestations present: ${allWithAttestations ? 'yes' : 'no'}; ` +
      `claims verified: ${allClaimsVerified ? 'yes' : 'no'}; ` +
      `crypto verification: not implemented)\n` +
      `Note: ${report.note}\n`,
  );
}
process.exit(0);
