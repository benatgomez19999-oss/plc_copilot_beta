// Sprint 65 + 70 — pure helpers behind `pnpm release:provenance`.
//
// Sprint 65 shipped a *stub* — local-only verification that the publish
// path is *configured* to mint provenance attestations:
//
//   1. `.github/workflows/publish.yml` grants `id-token: write` to the
//      publish job (required by npm to obtain an OIDC token for signing
//      the attestation), AND
//   2. The publish argv built by `release-publish-real-lib.mjs`
//      contains `--provenance` for every supported tag, never `--dry-run`.
//
// Sprint 70 layers real registry-metadata + attestation-claims
// verification on top of the stub. The default `release:provenance`
// invocation now:
//
//   3. Reads `npm view <pkg>@<version> --json` for every release
//      candidate and validates name / version / dist.integrity /
//      dist.tarball / repository / dist.attestations.url presence and
//      shape.
//   4. Fetches every package's npm-attestations endpoint, decodes the
//      DSSE envelope payload (base64), and validates the in-toto
//      Statement claims against the expected GitHub repo, the
//      `.github/workflows/publish.yml` source path, and the package
//      identity. The Sigstore-bundle *cryptographic* verification
//      (Fulcio chain walk + Rekor inclusion proof) is documented as
//      NOT implemented; this is metadata + claims-level verification.
//
// CRITICAL: nothing in this lib mutates anything — all spawns are read-
// only `npm view` calls and `fetch` GETs. Defence-in-depth assertion
// (`assertNoNpmMutationSurfaceProvenance`) refuses any argv that
// contains `publish` / `dist-tag` / `--no-dry-run`.

import {
  buildNpmPublishCommand,
  VALID_NPM_TAGS,
} from './release-publish-real-lib.mjs';
import {
  EXPECTED_PACKAGE_NAMES,
  RELEASE_PUBLISH_ORDER,
  parseSemver,
} from './release-plan-lib.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROVENANCE_DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const PROVENANCE_PACKAGE_ORDER = Object.freeze([...RELEASE_PUBLISH_ORDER]);
export const PROVENANCE_EXPECTED_REPO_URL =
  'https://github.com/benatgomez19999-oss/plc_copilot_beta';
export const PROVENANCE_EXPECTED_WORKFLOW_PATH = '.github/workflows/publish.yml';
export const PROVENANCE_EXPECTED_PREDICATE_TYPE =
  'https://slsa.dev/provenance/v1';

/**
 * Modes the runner exposes:
 *   - `config-only`    : Sprint 65 stub. No network. Safe for `ci:contracts`.
 *   - `metadata-only`  : Sprint 70 read-only registry path. No config check.
 *   - `default`        : config + metadata. Used by post-publish-verify.yml.
 */
export const PROVENANCE_MODES = Object.freeze(['default', 'config-only', 'metadata-only']);

function makeIssue(code, message, recommendation, level = 'error') {
  return {
    level,
    code,
    message,
    recommendation: recommendation ?? null,
  };
}

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

export function parseProvenanceArgs(argv) {
  if (!Array.isArray(argv)) {
    return {
      options: null,
      errors: [makeIssue('PROVENANCE_ARGV_INVALID', 'argv must be an array.')],
    };
  }
  const options = {
    version: null,
    registry: null,
    configOnly: false,
    metadataOnly: false,
    json: false,
    help: false,
  };
  const errors = [];

  function takeValue(flag, i) {
    const next = argv[i + 1];
    if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
      errors.push(
        makeIssue('PROVENANCE_FLAG_MISSING_VALUE', `${flag} requires a value.`),
      );
      return { value: null, consume: 0 };
    }
    return { value: next, consume: 1 };
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') {
      errors.push(makeIssue('PROVENANCE_ARG_INVALID', 'arguments must be strings.'));
      continue;
    }
    if (a === '--help' || a === '-h') options.help = true;
    else if (a === '--json') options.json = true;
    else if (a === '--config-only') options.configOnly = true;
    else if (a === '--metadata-only') options.metadataOnly = true;
    else if (a === '--version') {
      const r = takeValue('--version', i);
      options.version = r.value;
      i += r.consume;
    } else if (a.startsWith('--version=')) {
      options.version = a.slice('--version='.length);
    } else if (a === '--registry') {
      const r = takeValue('--registry', i);
      options.registry = r.value;
      i += r.consume;
    } else if (a.startsWith('--registry=')) {
      options.registry = a.slice('--registry='.length);
    } else if (
      a === '--publish' ||
      a === '--no-dry-run' ||
      a === '--dry-run' ||
      a === '--dist-tag' ||
      a === '--yes' ||
      a === '-y'
    ) {
      // Defence-in-depth: this runner is read-only. Any flag that
      // hints at npm mutation is rejected at parse time.
      errors.push(
        makeIssue(
          'PROVENANCE_UNKNOWN_FLAG',
          `${a} is not a valid release:provenance flag (this runner never mutates npm).`,
        ),
      );
    } else {
      errors.push(makeIssue('PROVENANCE_UNKNOWN_FLAG', `unknown argument: ${JSON.stringify(a)}`));
    }
  }

  if (options.configOnly && options.metadataOnly) {
    errors.push(
      makeIssue(
        'PROVENANCE_UNKNOWN_FLAG',
        '--config-only and --metadata-only are mutually exclusive.',
      ),
    );
  }

  return { options, errors };
}

/**
 * Resolve the requested mode from parsed options. Default = both layers.
 */
export function resolveProvenanceMode(options) {
  if (!options) return 'default';
  if (options.configOnly) return 'config-only';
  if (options.metadataOnly) return 'metadata-only';
  return 'default';
}

// ---------------------------------------------------------------------------
// Sprint 65 stub helpers — kept verbatim for back-compat
// ---------------------------------------------------------------------------

export function checkPublishWorkflowProvenance({ workflowText } = {}) {
  const issues = [];
  if (typeof workflowText !== 'string' || workflowText.length === 0) {
    issues.push(
      makeIssue(
        'PROVENANCE_WORKFLOW_MISSING',
        'publish workflow YAML is empty or unreadable.',
        'Make sure .github/workflows/publish.yml exists.',
      ),
    );
    return issues;
  }
  if (!/permissions:[\s\S]*?id-token:\s*write/.test(workflowText)) {
    issues.push(
      makeIssue(
        'PROVENANCE_WORKFLOW_NO_ID_TOKEN',
        'publish workflow does not grant `id-token: write` to the publish job.',
        'Add `id-token: write` to the job permissions block — npm provenance needs it for OIDC.',
      ),
    );
  }
  if (!/--provenance\b/.test(workflowText)) {
    issues.push(
      makeIssue(
        'PROVENANCE_WORKFLOW_NO_PROVENANCE_FLAG',
        'publish workflow YAML does not reference `--provenance`.',
        'Either invoke `release:publish-real` (which hardcodes the flag) or pass `--provenance` directly.',
      ),
    );
  }
  return issues;
}

export function checkPublishCommandProvenance({ tags = VALID_NPM_TAGS } = {}) {
  const issues = [];
  if (!Array.isArray(tags) || tags.length === 0) {
    issues.push(
      makeIssue('PROVENANCE_COMMAND_NO_TAGS', 'no tags supplied for the command-builder check.'),
    );
    return issues;
  }
  for (const tag of tags) {
    let args;
    try {
      args = buildNpmPublishCommand({ tag });
    } catch (e) {
      issues.push(
        makeIssue(
          'PROVENANCE_COMMAND_BUILDER_THREW',
          `buildNpmPublishCommand({tag:${JSON.stringify(tag)}}) threw: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
      continue;
    }
    if (!args.includes('--provenance')) {
      issues.push(
        makeIssue(
          'PROVENANCE_COMMAND_NO_PROVENANCE',
          `release-publish-real argv for tag ${JSON.stringify(tag)} does not include --provenance.`,
          'Ensure release-publish-real-lib.mjs#buildNpmPublishCommand still hardcodes the flag.',
        ),
      );
    }
    if (args.includes('--dry-run')) {
      issues.push(
        makeIssue(
          'PROVENANCE_COMMAND_DRY_RUN',
          `release-publish-real argv for tag ${JSON.stringify(tag)} unexpectedly contains --dry-run.`,
          'release:publish-real must never include --dry-run; that is a sprint-63 invariant.',
        ),
      );
    }
  }
  return issues;
}

export function buildProvenanceStubReport({ version, workflowIssues, commandIssues }) {
  const allIssues = [...(workflowIssues ?? []), ...(commandIssues ?? [])];
  return {
    ok: allIssues.length === 0,
    version: typeof version === 'string' ? version : null,
    checks: {
      workflow_id_token_write:
        Array.isArray(workflowIssues) &&
        !workflowIssues.some((i) => i.code === 'PROVENANCE_WORKFLOW_NO_ID_TOKEN'),
      workflow_provenance_flag:
        Array.isArray(workflowIssues) &&
        !workflowIssues.some((i) => i.code === 'PROVENANCE_WORKFLOW_NO_PROVENANCE_FLAG'),
      command_provenance_flag:
        Array.isArray(commandIssues) &&
        !commandIssues.some((i) => i.code === 'PROVENANCE_COMMAND_NO_PROVENANCE'),
      command_no_dry_run:
        Array.isArray(commandIssues) &&
        !commandIssues.some((i) => i.code === 'PROVENANCE_COMMAND_DRY_RUN'),
    },
    note:
      'Sprint 65 stub — verifies that publish path is *configured* for provenance. ' +
      'Deep attestation bundle verification against Sigstore is reserved for a future sprint.',
    issues: allIssues,
  };
}

// ---------------------------------------------------------------------------
// Sprint 70 — registry-metadata layer
// ---------------------------------------------------------------------------

const SCOPE_PREFIX = '@plccopilot/';

/**
 * `npm view <pkg>@<version> --json --registry <url>` argv. Frozen.
 */
export function buildNpmViewPackageArgs({ packageName, version, registry } = {}) {
  if (typeof packageName !== 'string' || !packageName.startsWith(SCOPE_PREFIX)) {
    throw new Error(
      `buildNpmViewPackageArgs: packageName must start with ${SCOPE_PREFIX} (got ${JSON.stringify(packageName)}).`,
    );
  }
  if (typeof version !== 'string' || parseSemver(version) === null) {
    throw new Error(
      `buildNpmViewPackageArgs: version must be strict X.Y.Z (got ${JSON.stringify(version)}).`,
    );
  }
  if (typeof registry !== 'string' || !/^https?:\/\//.test(registry)) {
    throw new Error(
      `buildNpmViewPackageArgs: registry must be an http(s) URL (got ${JSON.stringify(registry)}).`,
    );
  }
  return Object.freeze([
    'view',
    `${packageName}@${version}`,
    '--json',
    '--registry',
    registry,
  ]);
}

/**
 * Defence-in-depth assertion. Refuses to spawn an argv that has any
 * publish / dist-tag / mutation token. Sprint-70 runner calls this
 * before every `npm view` spawn.
 */
export function assertNoNpmMutationSurfaceProvenance(argv) {
  if (!Array.isArray(argv)) {
    throw new Error('assertNoNpmMutationSurfaceProvenance: argv must be an array.');
  }
  for (const a of argv) {
    if (typeof a !== 'string') {
      throw new Error(
        'assertNoNpmMutationSurfaceProvenance: every argv entry must be a string.',
      );
    }
    if (
      a === 'publish' ||
      a === '--publish' ||
      a === '--no-dry-run' ||
      a === 'dist-tag'
    ) {
      throw new Error(
        `assertNoNpmMutationSurfaceProvenance: refusing argv with mutation surface (${JSON.stringify(a)}).`,
      );
    }
  }
  return true;
}

/**
 * Tolerant `npm view --json` parser. Same shape as the promote-latest
 * lib — strips leading npm warn / notice lines.
 */
export function parseNpmViewJson(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    let cursor = -1;
    for (const ch of ['{', '[', '"']) {
      const i = stdout.indexOf(ch);
      if (i >= 0 && (cursor === -1 || i < cursor)) cursor = i;
    }
    if (cursor < 0) return null;
    try {
      return JSON.parse(stdout.slice(cursor));
    } catch {
      return null;
    }
  }
}

/**
 * Normalise a git/repository URL down to the canonical github.com form
 * used by `PROVENANCE_EXPECTED_REPO_URL`. Handles:
 *   - `git+https://github.com/.../*.git`
 *   - `https://github.com/...` (with or without `.git`)
 *   - trailing slashes
 *   - SSH form `git@github.com:owner/repo.git` (rare; not produced by npm)
 *
 * Returns the canonical form `https://github.com/<owner>/<repo>` or
 * `null` if the input is unrecognisable.
 */
export function normalizeRepositoryUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  let s = url.trim();
  if (s.startsWith('git+')) s = s.slice(4);
  if (s.startsWith('git@github.com:')) {
    s = `https://github.com/${s.slice('git@github.com:'.length)}`;
  }
  s = s.replace(/\.git$/, '');
  s = s.replace(/\/+$/, '');
  // Only github.com URLs are normalised; anything else is returned
  // as-is so the caller can flag mismatch.
  return s.length > 0 ? s : null;
}

/**
 * Validate `npm view` metadata for one package against expected
 * provenance-bearing fields.
 *
 * `metadata` is the parsed JSON object from `npm view <pkg>@<v> --json`.
 * `expected.packageName`, `expected.version` are required.
 * `expected.repositoryUrl` defaults to `PROVENANCE_EXPECTED_REPO_URL`.
 */
export function validatePackageMetadataProvenance(metadata, expected = {}) {
  const issues = [];
  const packageName = expected.packageName;
  const expectedVersion = expected.version;
  const expectedRepo =
    expected.repositoryUrl ?? PROVENANCE_EXPECTED_REPO_URL;

  if (metadata === null || metadata === undefined) {
    issues.push(
      makeIssue(
        'PROVENANCE_PACKAGE_NOT_FOUND',
        `${packageName ?? '<unknown>'}@${expectedVersion ?? '?'} returned no metadata.`,
      ),
    );
    return issues;
  }
  if (typeof metadata !== 'object') {
    issues.push(
      makeIssue(
        'PROVENANCE_NPM_VIEW_PARSE_FAILED',
        `${packageName}: metadata is not a JSON object (got ${typeof metadata}).`,
      ),
    );
    return issues;
  }

  // Identity.
  if (metadata.name !== packageName) {
    issues.push(
      makeIssue(
        'PROVENANCE_NAME_MISMATCH',
        `expected name ${JSON.stringify(packageName)}, got ${JSON.stringify(metadata.name)}.`,
      ),
    );
  }
  if (metadata.version !== expectedVersion) {
    issues.push(
      makeIssue(
        'PROVENANCE_VERSION_MISMATCH',
        `expected version ${JSON.stringify(expectedVersion)}, got ${JSON.stringify(metadata.version)}.`,
      ),
    );
  }

  // dist
  const dist = metadata.dist;
  if (!dist || typeof dist !== 'object') {
    issues.push(
      makeIssue(
        'PROVENANCE_DIST_MISSING',
        `${packageName}: dist object is missing.`,
      ),
    );
    return issues;
  }
  if (typeof dist.integrity !== 'string' || dist.integrity.length === 0) {
    issues.push(
      makeIssue(
        'PROVENANCE_INTEGRITY_MISSING',
        `${packageName}: dist.integrity is missing or empty.`,
      ),
    );
  }
  if (typeof dist.tarball !== 'string' || !/^https?:\/\//.test(dist.tarball)) {
    issues.push(
      makeIssue(
        'PROVENANCE_TARBALL_MISSING',
        `${packageName}: dist.tarball is missing or not an http(s) URL.`,
      ),
    );
  }
  // dist.attestations exposed by npm when the package was published
  // with --provenance. Required for Sprint 70 metadata-level success.
  const attestations = dist.attestations;
  if (!attestations || typeof attestations !== 'object') {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_MISSING',
        `${packageName}: dist.attestations is missing — package was not published with --provenance.`,
      ),
    );
  } else if (
    typeof attestations.url !== 'string' ||
    !/^https?:\/\//.test(attestations.url)
  ) {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_URL_INVALID',
        `${packageName}: dist.attestations.url is missing or not an http(s) URL.`,
      ),
    );
  }

  // Repository linkage.
  const repository = metadata.repository;
  if (!repository || typeof repository !== 'object') {
    issues.push(
      makeIssue(
        'PROVENANCE_REPOSITORY_MISSING',
        `${packageName}: repository field is missing.`,
      ),
    );
  } else {
    const normalized = normalizeRepositoryUrl(repository.url);
    if (!normalized || normalized !== expectedRepo) {
      issues.push(
        makeIssue(
          'PROVENANCE_REPOSITORY_URL_MISMATCH',
          `${packageName}: repository.url ${JSON.stringify(repository.url)} (normalised: ${JSON.stringify(normalized)}) does not match expected ${JSON.stringify(expectedRepo)}.`,
        ),
      );
    }
    // Resolve expected directory from EXPECTED_PACKAGE_NAMES inverse.
    const dir = Object.keys(EXPECTED_PACKAGE_NAMES).find(
      (d) => EXPECTED_PACKAGE_NAMES[d] === packageName,
    );
    const expectedDir = dir ? `packages/${dir}` : null;
    if (expectedDir && repository.directory && repository.directory !== expectedDir) {
      issues.push(
        makeIssue(
          'PROVENANCE_REPOSITORY_DIRECTORY_MISMATCH',
          `${packageName}: repository.directory ${JSON.stringify(repository.directory)} does not match expected ${JSON.stringify(expectedDir)}.`,
        ),
      );
    }
  }

  if (typeof metadata.gitHead !== 'string' || metadata.gitHead.length === 0) {
    issues.push(
      makeIssue(
        'PROVENANCE_GIT_HEAD_MISSING',
        `${packageName}: gitHead is not exposed by npm view (informational; npm does not always expose it).`,
        null,
        'warning',
      ),
    );
  }

  return issues;
}

/**
 * Pluck the SLSA provenance attestation entry out of the raw npm
 * attestations endpoint response. Shape (observed against
 * `https://registry.npmjs.org/-/npm/v1/attestations/<pkg>@<v>` for an
 * `npm publish --provenance` package on 2026-04-27):
 *
 *   {
 *     "attestations": [
 *       { "predicateType": "https://github.com/npm/attestation/...", "bundle": {...} },
 *       { "predicateType": "https://slsa.dev/provenance/v1",         "bundle": {...} }
 *     ]
 *   }
 *
 * Returns the SLSA entry (or null) and a list of issues.
 */
export function extractAttestationsBundle(rawJson) {
  const issues = [];
  if (rawJson === null || rawJson === undefined) {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_PARSE_FAILED',
        'attestations response is empty.',
      ),
    );
    return { slsa: null, npm: null, issues };
  }
  if (typeof rawJson !== 'object' || !Array.isArray(rawJson.attestations)) {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_PARSE_FAILED',
        `attestations response is not an object with an attestations[] array (got ${typeof rawJson}).`,
      ),
    );
    return { slsa: null, npm: null, issues };
  }
  let slsa = null;
  let npm = null;
  for (const entry of rawJson.attestations) {
    if (!entry || typeof entry !== 'object') continue;
    const pt = entry.predicateType;
    if (typeof pt !== 'string') continue;
    if (pt.includes('slsa.dev/provenance')) slsa = entry;
    else if (pt.includes('npm/attestation')) npm = entry;
  }
  if (slsa === null) {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_PARSE_FAILED',
        'attestations response does not contain a slsa.dev/provenance entry.',
      ),
    );
  }
  return { slsa, npm, issues };
}

/**
 * Decode the base64-encoded DSSE envelope payload of a Sigstore bundle.
 * Returns the parsed in-toto Statement (or null).
 */
export function decodeDsseProvenancePayload(bundleEntry) {
  const issues = [];
  if (!bundleEntry || typeof bundleEntry !== 'object') {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_PARSE_FAILED',
        'attestation entry is missing or not an object.',
      ),
    );
    return { statement: null, issues };
  }
  const dsse = bundleEntry.bundle?.dsseEnvelope;
  if (!dsse || typeof dsse !== 'object') {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_PARSE_FAILED',
        'attestation entry has no bundle.dsseEnvelope.',
      ),
    );
    return { statement: null, issues };
  }
  if (typeof dsse.payload !== 'string' || dsse.payload.length === 0) {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_PARSE_FAILED',
        'attestation dsseEnvelope.payload is missing or empty.',
      ),
    );
    return { statement: null, issues };
  }
  let decoded;
  try {
    decoded = Buffer.from(dsse.payload, 'base64').toString('utf-8');
  } catch (e) {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_PARSE_FAILED',
        `failed to base64-decode dsseEnvelope.payload: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
    return { statement: null, issues };
  }
  let statement;
  try {
    statement = JSON.parse(decoded);
  } catch (e) {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_PARSE_FAILED',
        `dsseEnvelope.payload did not decode to JSON: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
    return { statement: null, issues };
  }
  return { statement, issues };
}

/**
 * Validate the in-toto Statement claims against the expected
 * package + repo + workflow. This is *claims-level* verification —
 * it does NOT verify the bundle signature or walk the Fulcio cert
 * chain (those require Sigstore tooling and are not implemented).
 */
export function validateAttestationClaims(statement, expected = {}) {
  const issues = [];
  if (!statement || typeof statement !== 'object') {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_PARSE_FAILED',
        'in-toto statement is missing or not an object.',
      ),
    );
    return issues;
  }
  const expectedRepo = expected.repositoryUrl ?? PROVENANCE_EXPECTED_REPO_URL;
  const expectedWorkflowPath =
    expected.workflowPath ?? PROVENANCE_EXPECTED_WORKFLOW_PATH;
  const packageName = expected.packageName;
  const expectedVersion = expected.version;

  // subject — `pkg:npm/<encoded-name>@<version>`. The scope `/` is
  // URL-encoded as `%40` ... `%2F` in the subject name; npm uses both
  // forms historically. We compare in a tolerant way.
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  if (subjects.length === 0) {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_PARSE_FAILED',
        'in-toto statement has no subject[] entries.',
      ),
    );
  } else {
    const expectedSubjectName = `pkg:npm/${packageName?.replace('@', '%40').replace('/', '/')}@${expectedVersion}`;
    const decodedExpected = `pkg:npm/${packageName}@${expectedVersion}`;
    const matched = subjects.some((s) => {
      if (!s || typeof s.name !== 'string') return false;
      try {
        return decodeURIComponent(s.name) === decodedExpected;
      } catch {
        return s.name === expectedSubjectName || s.name === decodedExpected;
      }
    });
    if (!matched) {
      issues.push(
        makeIssue(
          'PROVENANCE_ATTESTATION_REPO_MISMATCH',
          `in-toto subject does not include ${decodedExpected}; got ${JSON.stringify(subjects.map((s) => s?.name))}.`,
        ),
      );
    }
  }

  // predicateType — must be SLSA provenance.
  if (
    typeof statement.predicateType !== 'string' ||
    !statement.predicateType.includes('slsa.dev/provenance')
  ) {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_REPO_MISMATCH',
        `in-toto predicateType ${JSON.stringify(statement.predicateType)} is not slsa.dev/provenance.`,
      ),
    );
  }

  // predicate.buildDefinition.externalParameters.workflow.{repository,path}
  const workflow =
    statement.predicate?.buildDefinition?.externalParameters?.workflow;
  if (!workflow || typeof workflow !== 'object') {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_WORKFLOW_MISMATCH',
        'in-toto predicate.buildDefinition.externalParameters.workflow is missing.',
      ),
    );
  } else {
    const repoNorm = normalizeRepositoryUrl(workflow.repository);
    if (!repoNorm || repoNorm !== expectedRepo) {
      issues.push(
        makeIssue(
          'PROVENANCE_ATTESTATION_REPO_MISMATCH',
          `attestation workflow.repository ${JSON.stringify(workflow.repository)} (normalised: ${JSON.stringify(repoNorm)}) does not match expected ${JSON.stringify(expectedRepo)}.`,
        ),
      );
    }
    if (workflow.path !== expectedWorkflowPath) {
      issues.push(
        makeIssue(
          'PROVENANCE_ATTESTATION_WORKFLOW_MISMATCH',
          `attestation workflow.path ${JSON.stringify(workflow.path)} does not match expected ${JSON.stringify(expectedWorkflowPath)}.`,
        ),
      );
    }
  }

  // resolvedDependencies[0].digest.gitCommit — record only.
  const resolvedDeps =
    statement.predicate?.buildDefinition?.resolvedDependencies;
  if (Array.isArray(resolvedDeps) && resolvedDeps[0]?.digest?.gitCommit) {
    // No issue — recorded as info elsewhere.
  } else {
    issues.push(
      makeIssue(
        'PROVENANCE_ATTESTATION_WORKFLOW_MISMATCH',
        'in-toto predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit is missing.',
        null,
        'warning',
      ),
    );
  }

  return issues;
}

/**
 * Extract the gitCommit recorded in the attestation, or null.
 */
export function extractAttestationGitCommit(statement) {
  const commit =
    statement?.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest
      ?.gitCommit;
  return typeof commit === 'string' && /^[a-f0-9]{7,64}$/i.test(commit)
    ? commit
    : null;
}

// ---------------------------------------------------------------------------
// Sprint 70 — full report builder
// ---------------------------------------------------------------------------

/**
 * Aggregate per-package + config results into the top-level Sprint 70
 * report. The shape is stable JSON suitable for consumers / CI agents.
 */
export function buildProvenanceReport({
  mode,
  version,
  registry,
  configChecks,
  packageResults,
  cryptoVerified = false,
}) {
  if (!PROVENANCE_MODES.includes(mode)) {
    throw new Error(
      `buildProvenanceReport: unknown mode ${JSON.stringify(mode)}.`,
    );
  }
  const allIssues = [];

  // Config-only or default mode contribute config issues.
  if (mode !== 'metadata-only') {
    if (Array.isArray(configChecks?.issues)) {
      for (const i of configChecks.issues) allIssues.push(i);
    }
  }

  // Metadata-only or default mode contribute per-package issues.
  if (mode !== 'config-only') {
    if (Array.isArray(packageResults)) {
      for (const r of packageResults) {
        if (Array.isArray(r.issues)) {
          for (const i of r.issues) allIssues.push(i);
        }
      }
    }
  }

  const errorCount = allIssues.filter((i) => i.level === 'error').length;
  const ok = errorCount === 0;

  return {
    ok,
    version: typeof version === 'string' ? version : null,
    registry: typeof registry === 'string' ? registry : null,
    mode,
    config:
      mode !== 'metadata-only' && configChecks
        ? {
            workflow_id_token_write: configChecks.workflow_id_token_write === true,
            publish_command_provenance_flag:
              configChecks.publish_command_provenance_flag === true,
            publish_command_no_dry_run:
              configChecks.publish_command_no_dry_run === true,
          }
        : null,
    packages:
      mode !== 'config-only' && Array.isArray(packageResults)
        ? packageResults.map((r) => ({
            name: r.name ?? null,
            version: r.version ?? null,
            repository_ok: r.issues?.every?.(
              (i) =>
                i.code !== 'PROVENANCE_REPOSITORY_URL_MISMATCH' &&
                i.code !== 'PROVENANCE_REPOSITORY_DIRECTORY_MISMATCH' &&
                i.code !== 'PROVENANCE_REPOSITORY_MISSING',
            ) ?? true,
            dist_integrity: r.distIntegrity === true,
            tarball: r.tarball === true,
            attestations: r.attestations
              ? {
                  present: r.attestations.present === true,
                  url: r.attestations.url ?? null,
                  predicate_type: r.attestations.predicateType ?? null,
                  workflow_path: r.attestations.workflowPath ?? null,
                  repository_url: r.attestations.repositoryUrl ?? null,
                  git_commit: r.attestations.gitCommit ?? null,
                  claims_verified: r.attestations.claimsVerified === true,
                  cryptographically_verified: false,
                }
              : { present: false, claims_verified: false, cryptographically_verified: false },
            issues: r.issues ?? [],
          }))
        : null,
    cryptographic_verification: {
      implemented: false,
      verified: false,
      note:
        'Cryptographic Sigstore-bundle verification (Fulcio cert chain walk + Rekor inclusion proof) is NOT implemented. ' +
        'Sprint 70 verifies attestation claims (in-toto subject + workflow.repository + workflow.path) but does not validate the bundle signature.',
    },
    note:
      mode === 'config-only'
        ? 'Sprint 65 stub — configuration checks only. Use --metadata-only or default to verify against the registry.'
        : mode === 'metadata-only'
          ? 'Sprint 70 metadata mode — registry metadata + attestation claims verified. Cryptographic Sigstore verification NOT implemented.'
          : 'Sprint 70 default mode — config + registry metadata + attestation claims verified. Cryptographic Sigstore verification NOT implemented.',
    issues: allIssues,
  };
}
