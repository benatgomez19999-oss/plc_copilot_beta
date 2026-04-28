// Sprint 71 — pure helpers behind `pnpm release:audit-signatures`.
//
// The runner wraps `npm audit signatures`, which (verified empirically
// against `@plccopilot/cli@0.1.0` on 2026-04-28 with npm 11.11.0)
// validates BOTH:
//   - npm registry package signatures
//   - npm provenance attestations
//
// JSON output shape (stable across success / failure):
//   {
//     "invalid": [ { name, version, code, ... }, ... ],
//     "missing": [ { name, version, ... }, ... ]
//   }
// Both arrays empty = pass. Anything else = fail.
//
// CRITICAL: this lib has zero codepaths that mutate npm. The only npm
// commands it builds are `install` (into a temp dir) and
// `audit signatures`. `assertNoNpmMutationSurfaceAuditSignatures`
// rejects any argv with a publish / dist-tag token before spawn.

import { parseSemver } from './release-plan-lib.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AUDIT_SIGNATURES_DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const AUDIT_SIGNATURES_DEFAULT_PACKAGE = '@plccopilot/cli';
export const AUDIT_SIGNATURES_SCOPE = '@plccopilot/';

/**
 * The flags we always pass to `npm install` in the temp consumer
 * project. These are belt-and-braces:
 *
 *   --ignore-scripts  - never run lifecycle scripts of dependencies.
 *                       The consumer project doesn't trust them; we
 *                       only want the metadata + tarballs on disk.
 *   --no-audit        - we'll run `npm audit signatures` ourselves;
 *                       the install step doesn't need to also audit.
 *   --no-fund         - skip funding banner noise.
 *
 * `--registry <url>` is appended at build time.
 */
export const AUDIT_SIGNATURES_INSTALL_FLAGS = Object.freeze([
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
]);

export const AUDIT_SIGNATURES_DEFAULTS = Object.freeze({
  registry: AUDIT_SIGNATURES_DEFAULT_REGISTRY,
  packageName: AUDIT_SIGNATURES_DEFAULT_PACKAGE,
  installFlags: AUDIT_SIGNATURES_INSTALL_FLAGS,
});

function makeIssue(code, message, recommendation, level = 'error') {
  return { level, code, message, recommendation: recommendation ?? null };
}

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

export function parseAuditSignaturesArgs(argv) {
  if (!Array.isArray(argv)) {
    return {
      options: null,
      errors: [makeIssue('AUDIT_SIGNATURES_ARG_INVALID', 'argv must be an array.')],
    };
  }
  const options = {
    version: null,
    registry: null,
    packageName: null,
    keep: false,
    json: false,
    help: false,
  };
  const errors = [];

  function takeValue(flag, i) {
    const next = argv[i + 1];
    if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
      errors.push(
        makeIssue('AUDIT_SIGNATURES_FLAG_MISSING_VALUE', `${flag} requires a value.`),
      );
      return { value: null, consume: 0 };
    }
    return { value: next, consume: 1 };
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') {
      errors.push(makeIssue('AUDIT_SIGNATURES_ARG_INVALID', 'arguments must be strings.'));
      continue;
    }
    if (a === '--help' || a === '-h') options.help = true;
    else if (a === '--json') options.json = true;
    else if (a === '--keep') options.keep = true;
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
    } else if (a === '--package') {
      const r = takeValue('--package', i);
      options.packageName = r.value;
      i += r.consume;
    } else if (a.startsWith('--package=')) {
      options.packageName = a.slice('--package='.length);
    } else if (
      a === '--publish' ||
      a === '--no-dry-run' ||
      a === '--dry-run' ||
      a === '--dist-tag' ||
      a === '--yes' ||
      a === '-y'
    ) {
      // Defence-in-depth: this runner never mutates npm.
      errors.push(
        makeIssue(
          'AUDIT_SIGNATURES_UNKNOWN_FLAG',
          `${a} is not a valid release:audit-signatures flag (this runner never mutates npm).`,
        ),
      );
    } else {
      errors.push(
        makeIssue(
          'AUDIT_SIGNATURES_UNKNOWN_FLAG',
          `unknown argument: ${JSON.stringify(a)}`,
        ),
      );
    }
  }

  return { options, errors };
}

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

export function validateAuditSignaturesOptions(rawOptions, workspace) {
  const overrides = {};
  for (const [k, v] of Object.entries(rawOptions ?? {})) {
    if (v !== null && v !== undefined) overrides[k] = v;
  }
  const options = {
    version: null,
    registry: AUDIT_SIGNATURES_DEFAULT_REGISTRY,
    packageName: AUDIT_SIGNATURES_DEFAULT_PACKAGE,
    keep: false,
    json: false,
    help: false,
    ...overrides,
  };
  const issues = [];

  // Version: try to derive from workspace if not given.
  if (!options.version && workspace) {
    const versions = new Set();
    for (const c of workspace.candidates ?? []) {
      if (c.missing || !c.pkg) continue;
      const v = c.pkg.parsed?.version;
      if (typeof v === 'string') versions.add(v);
    }
    if (versions.size === 1) options.version = [...versions][0];
  }

  if (typeof options.version !== 'string' || options.version.length === 0) {
    issues.push(
      makeIssue(
        'AUDIT_SIGNATURES_VERSION_REQUIRED',
        '--version is required.',
        'Pass --version X.Y.Z (must equal a published version).',
      ),
    );
  } else if (parseSemver(options.version) === null) {
    issues.push(
      makeIssue(
        'AUDIT_SIGNATURES_VERSION_INVALID',
        `--version ${JSON.stringify(options.version)} is not strict X.Y.Z.`,
      ),
    );
  }

  if (
    typeof options.registry !== 'string' ||
    !/^https?:\/\//.test(options.registry)
  ) {
    issues.push(
      makeIssue(
        'AUDIT_SIGNATURES_REGISTRY_INVALID',
        '--registry must be an http(s) URL.',
      ),
    );
  }

  if (
    typeof options.packageName !== 'string' ||
    !options.packageName.startsWith(AUDIT_SIGNATURES_SCOPE) ||
    options.packageName.length === AUDIT_SIGNATURES_SCOPE.length
  ) {
    issues.push(
      makeIssue(
        'AUDIT_SIGNATURES_PACKAGE_INVALID',
        `--package must start with ${AUDIT_SIGNATURES_SCOPE} (got ${JSON.stringify(options.packageName)}).`,
        'Pass --package @plccopilot/<name>; default is @plccopilot/cli (pulls the full internal graph).',
      ),
    );
  }

  return { options, issues };
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

/**
 * Build the install argv for the temp consumer project. Frozen.
 *
 * Always emits:
 *   install <pkg>@<version>
 *   --ignore-scripts --no-audit --no-fund
 *   --registry <url>
 *
 * Never includes mutation tokens.
 */
export function buildNpmInstallArgs({ packageName, version, registry } = {}) {
  if (
    typeof packageName !== 'string' ||
    !packageName.startsWith(AUDIT_SIGNATURES_SCOPE)
  ) {
    throw new Error(
      `buildNpmInstallArgs: packageName must start with ${AUDIT_SIGNATURES_SCOPE} (got ${JSON.stringify(packageName)}).`,
    );
  }
  if (typeof version !== 'string' || parseSemver(version) === null) {
    throw new Error(
      `buildNpmInstallArgs: version must be strict X.Y.Z (got ${JSON.stringify(version)}).`,
    );
  }
  if (typeof registry !== 'string' || !/^https?:\/\//.test(registry)) {
    throw new Error(
      `buildNpmInstallArgs: registry must be a http(s) URL (got ${JSON.stringify(registry)}).`,
    );
  }
  return Object.freeze([
    'install',
    `${packageName}@${version}`,
    ...AUDIT_SIGNATURES_INSTALL_FLAGS,
    '--registry',
    registry,
  ]);
}

/**
 * Build the `npm audit signatures` argv. Frozen.
 *
 *   npm audit signatures           (text mode)
 *   npm audit signatures --json    (JSON mode)
 */
export function buildNpmAuditSignaturesArgs({ json = false } = {}) {
  const args = ['audit', 'signatures'];
  if (json) args.push('--json');
  return Object.freeze(args);
}

/**
 * Defence-in-depth: refuse to spawn an argv that contains any
 * publish/dist-tag/mutation token. The runner calls this against
 * every argv before spawn (install + audit-signatures + view).
 */
export function assertNoNpmMutationSurfaceAuditSignatures(argv) {
  if (!Array.isArray(argv)) {
    throw new Error('assertNoNpmMutationSurfaceAuditSignatures: argv must be an array.');
  }
  for (const a of argv) {
    if (typeof a !== 'string') {
      throw new Error(
        'assertNoNpmMutationSurfaceAuditSignatures: every argv entry must be a string.',
      );
    }
    if (
      a === 'publish' ||
      a === '--publish' ||
      a === '--no-dry-run' ||
      a === 'dist-tag'
    ) {
      throw new Error(
        `assertNoNpmMutationSurfaceAuditSignatures: refusing argv with mutation surface (${JSON.stringify(a)}).`,
      );
    }
  }
  return true;
}

/**
 * Build the spec the audit step expects to find installed.
 * Useful for both diagnostics and tests.
 */
export function buildInstalledPackageSpec({ packageName, version } = {}) {
  if (
    typeof packageName !== 'string' ||
    !packageName.startsWith(AUDIT_SIGNATURES_SCOPE)
  ) {
    throw new Error(
      `buildInstalledPackageSpec: bad packageName ${JSON.stringify(packageName)}.`,
    );
  }
  if (typeof version !== 'string' || parseSemver(version) === null) {
    throw new Error(
      `buildInstalledPackageSpec: bad version ${JSON.stringify(version)}.`,
    );
  }
  return `${packageName}@${version}`;
}

// ---------------------------------------------------------------------------
// Output parsing + failure detection
// ---------------------------------------------------------------------------

/**
 * Tolerant JSON parser for `npm audit signatures --json` stdout. The
 * empirically-observed shape is `{ invalid: [], missing: [] }`. We
 * still tolerate leading npm-warn lines (npm sometimes leaks them
 * through `--json`).
 */
export function parseAuditSignaturesJson(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    let cursor = -1;
    for (const ch of ['{', '[']) {
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

const UNSUPPORTED_PATTERNS = Object.freeze([
  /unknown command:\s*signatures/i,
  /not a valid command/i,
  /audit signatures.*not supported/i,
  /this command requires npm/i,
]);

const SIGNATURE_FAILURE_PATTERNS = Object.freeze([
  /signatures? (?:do not match|is invalid|verification failed)/i,
  /eintegrity/i,
  /tampered/i,
]);

const NO_SIGNATURES_PATTERNS = Object.freeze([
  /no (?:registry )?signatures/i,
  /signatures.*not (?:available|present|exposed)/i,
  /no audit signatures available/i,
  /this registry does not support/i,
]);

const PACKAGE_NOT_FOUND_PATTERNS = Object.freeze([
  /\bE404\b/i,
  /404 Not Found/i,
  /no matching version found/i,
  /is not in the npm registry/i,
]);

export function isNpmAuditSignaturesUnsupported(stderr, stdout) {
  const text = `${typeof stderr === 'string' ? stderr : ''}\n${typeof stdout === 'string' ? stdout : ''}`;
  return UNSUPPORTED_PATTERNS.some((rx) => rx.test(text));
}

export function isSignatureFailure(stderr, stdout) {
  const text = `${typeof stderr === 'string' ? stderr : ''}\n${typeof stdout === 'string' ? stdout : ''}`;
  return SIGNATURE_FAILURE_PATTERNS.some((rx) => rx.test(text));
}

export function isNoSignaturesFound(stderr, stdout) {
  const text = `${typeof stderr === 'string' ? stderr : ''}\n${typeof stdout === 'string' ? stdout : ''}`;
  return NO_SIGNATURES_PATTERNS.some((rx) => rx.test(text));
}

export function isPackageNotFoundError(stderr, stdout) {
  const text = `${typeof stderr === 'string' ? stderr : ''}\n${typeof stdout === 'string' ? stdout : ''}`;
  return PACKAGE_NOT_FOUND_PATTERNS.some((rx) => rx.test(text));
}

/**
 * Truncate captured stdout/stderr to a manageable size for the JSON
 * report. Default 1500 chars — enough for diagnostic context, small
 * enough to avoid blowing up the report.
 */
export function summarizeSpawnFailure(label, result, max = 1500) {
  if (!result || typeof result !== 'object') {
    return `${label}: <no result>`;
  }
  const out =
    typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '');
  const err =
    typeof result.stderr === 'string' ? result.stderr : String(result.stderr ?? '');
  const trim = (s) =>
    typeof s === 'string' && s.length > max
      ? `${s.slice(0, max)}…(truncated)`
      : s;
  return {
    label,
    status: typeof result.status === 'number' ? result.status : null,
    stdout: trim(out),
    stderr: trim(err),
  };
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

/**
 * Build the stable JSON report. Inputs are individual phase results;
 * the function aggregates `ok` strictly: ok=true iff every phase
 * succeeded AND `invalid==[]` AND `missing==[]`.
 */
export function buildAuditSignaturesReport({
  version,
  registry,
  packageName,
  installResult,
  auditResult,
  auditJson,
  installIssues,
  auditIssues,
  tempDir,
}) {
  const issues = [
    ...(installIssues ?? []),
    ...(auditIssues ?? []),
  ];

  const installed =
    !!installResult &&
    typeof installResult.status === 'number' &&
    installResult.status === 0;

  const auditExitOk =
    !!auditResult &&
    typeof auditResult.status === 'number' &&
    auditResult.status === 0;

  const invalidCount =
    auditJson && Array.isArray(auditJson.invalid) ? auditJson.invalid.length : null;
  const missingCount =
    auditJson && Array.isArray(auditJson.missing) ? auditJson.missing.length : null;

  // Pass = npm audit signatures exited 0 AND both invalid + missing
  // arrays are empty (we observed `{"invalid":[],"missing":[]}` on
  // success). If JSON couldn't be parsed but exit==0 and the install
  // succeeded, fall back to assuming pass — but only as a last resort
  // (unit-tested: the runner never silently passes a non-zero audit).
  const passed =
    installed &&
    auditExitOk &&
    (invalidCount === null
      ? true
      : invalidCount === 0 && (missingCount ?? 0) === 0);

  const errorIssues = issues.filter((i) => i.level === 'error');
  const ok = installed && auditExitOk && passed && errorIssues.length === 0;

  return {
    ok,
    version: typeof version === 'string' ? version : null,
    registry: typeof registry === 'string' ? registry : null,
    package: typeof packageName === 'string' ? packageName : null,
    installed,
    audit_signatures: {
      status: typeof auditResult?.status === 'number' ? auditResult.status : null,
      passed,
      invalid_count: invalidCount,
      missing_count: missingCount,
      raw: auditJson ?? null,
      stdout_summary: typeof auditResult?.stdout === 'string'
        ? truncate(auditResult.stdout)
        : null,
      stderr_summary: typeof auditResult?.stderr === 'string'
        ? truncate(auditResult.stderr)
        : null,
    },
    install_summary: installResult
      ? {
          status: typeof installResult.status === 'number' ? installResult.status : null,
          stdout_summary:
            typeof installResult.stdout === 'string'
              ? truncate(installResult.stdout)
              : null,
          stderr_summary:
            typeof installResult.stderr === 'string'
              ? truncate(installResult.stderr)
              : null,
        }
      : null,
    temp_dir: typeof tempDir === 'string' ? tempDir : null,
    note:
      'Sprint 71 — wraps `npm audit signatures` against a fresh temp ' +
      'consumer project. npm audit signatures verifies registry ' +
      'signatures AND provenance attestations for the installed ' +
      'graph. This is the npm-supported cryptographic check; it does ' +
      'NOT replace the Sprint 70 attestation-claims verification ' +
      '(GitHub repo / workflow path / git commit), and it is NOT a ' +
      'custom Sigstore Fulcio + Rekor verification.',
    issues,
  };
}

function truncate(s, max = 1500) {
  if (typeof s !== 'string') return null;
  return s.length > max ? `${s.slice(0, max)}…(truncated)` : s;
}
