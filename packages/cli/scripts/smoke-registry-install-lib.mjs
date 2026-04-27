// Sprint 64 — pure helpers behind `pnpm release:registry-smoke`.
//
// The runner installs `@plccopilot/cli@<version>` from a real npm
// registry into a fresh temp project and runs the installed bin. The
// helpers here cover argument parsing, command building, bin-path
// resolution, registry-404 detection, and spawn-failure formatting,
// so the runner stays small and the lib stays unit-testable without
// ever hitting the network.

import { join } from 'node:path';

import { EXPECTED_PACKAGE_NAMES, parseSemver } from './release-plan-lib.mjs';

export const REGISTRY_SMOKE_DEFAULTS = Object.freeze({
  registry: 'https://registry.npmjs.org',
  packageName: '@plccopilot/cli',
});

const PUBLISH_SCOPE_PREFIX = '@plccopilot/';

function makeIssue(code, message, recommendation) {
  return { level: 'error', code, message, recommendation: recommendation ?? null };
}

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

/**
 * Parse the registry-smoke runner's argv. Returns the option bag plus
 * an `errors[]` array of usage problems (unknown flag, missing value).
 * Does NOT validate semantic correctness — that is `validateRegistrySmokeOptions`.
 *
 * Recognised flags:
 *   --version X.Y.Z
 *   --registry URL
 *   --package @scope/name
 *   --keep
 *   --help / -h
 */
export function parseRegistrySmokeArgs(argv) {
  if (!Array.isArray(argv)) {
    return {
      options: null,
      errors: [makeIssue('REGISTRY_SMOKE_ARGV_INVALID', 'argv must be an array.', null)],
    };
  }
  const options = {
    version: null,
    registry: null,
    packageName: null,
    keep: false,
    help: false,
  };
  const errors = [];

  function takeValue(flag, i) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      errors.push(
        makeIssue(
          'REGISTRY_SMOKE_FLAG_MISSING_VALUE',
          `${flag} requires a value.`,
          null,
        ),
      );
      return { value: null, consume: 0 };
    }
    return { value: next, consume: 1 };
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') {
      errors.push(
        makeIssue('REGISTRY_SMOKE_ARG_INVALID', 'arguments must be strings.', null),
      );
      continue;
    }
    if (a === '--help' || a === '-h') options.help = true;
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
    } else {
      errors.push(
        makeIssue(
          'REGISTRY_SMOKE_UNKNOWN_FLAG',
          `unknown argument: ${JSON.stringify(a)}`,
          'Run with --help for the supported flag list.',
        ),
      );
    }
  }

  return { options, errors };
}

// ---------------------------------------------------------------------------
// Option validator
// ---------------------------------------------------------------------------

/**
 * Apply defaults and validate one parsed option bag against an
 * optional release workspace. The workspace is consulted only to
 * derive a default version when `--version` was not passed; if the
 * caller passed `--version` explicitly, we trust it.
 *
 * Returns `{ options, issues }`. `options` is fully resolved (defaults
 * applied) when issues is empty.
 */
export function validateRegistrySmokeOptions(rawOptions, workspace) {
  // Only override defaults with explicitly-set (non-null/undefined)
  // values. The parser uses `null` for "flag not seen", which would
  // otherwise blank out the default registry / packageName.
  const overrides = {};
  for (const [k, v] of Object.entries(rawOptions ?? {})) {
    if (v !== null && v !== undefined) overrides[k] = v;
  }
  const options = { ...REGISTRY_SMOKE_DEFAULTS, ...overrides };
  const issues = [];

  // Default version comes from the workspace if not given.
  if (!options.version && workspace) {
    const versions = new Set();
    for (const c of workspace.candidates) {
      if (c.missing || !c.pkg) continue;
      const v = c.pkg.parsed?.version;
      if (typeof v === 'string') versions.add(v);
    }
    if (versions.size === 1) {
      options.version = [...versions][0];
    }
  }

  if (!options.version || typeof options.version !== 'string') {
    issues.push(
      makeIssue(
        'REGISTRY_SMOKE_VERSION_REQUIRED',
        '--version is required (and the workspace did not have a single shared version).',
        'Pass --version X.Y.Z or align the workspace first with `pnpm release:check`.',
      ),
    );
  } else if (parseSemver(options.version) === null) {
    issues.push(
      makeIssue(
        'REGISTRY_SMOKE_VERSION_INVALID',
        `--version ${JSON.stringify(options.version)} is not strict X.Y.Z.`,
        'Use a strict semver such as 0.1.0.',
      ),
    );
  }

  if (typeof options.registry !== 'string' || options.registry.length === 0) {
    issues.push(
      makeIssue(
        'REGISTRY_SMOKE_REGISTRY_INVALID',
        '--registry must be a non-empty URL.',
        null,
      ),
    );
  } else if (!/^https?:\/\//.test(options.registry)) {
    issues.push(
      makeIssue(
        'REGISTRY_SMOKE_REGISTRY_INVALID',
        `--registry ${JSON.stringify(options.registry)} must start with http:// or https://.`,
        null,
      ),
    );
  }

  if (typeof options.packageName !== 'string' || options.packageName.length === 0) {
    issues.push(
      makeIssue(
        'REGISTRY_SMOKE_PACKAGE_INVALID',
        '--package must be a non-empty package name.',
        null,
      ),
    );
  } else if (!options.packageName.startsWith(PUBLISH_SCOPE_PREFIX)) {
    issues.push(
      makeIssue(
        'REGISTRY_SMOKE_PACKAGE_OUT_OF_SCOPE',
        `--package ${JSON.stringify(options.packageName)} is not under ${PUBLISH_SCOPE_PREFIX}*.`,
        `Use one of: ${Object.values(EXPECTED_PACKAGE_NAMES).join(', ')}`,
      ),
    );
  }

  return { options, issues };
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

/**
 * Build the `npm install` argv used by the runner. Always includes
 * `--ignore-scripts --no-audit --no-fund` for safety + speed, the
 * `--registry` flag, and the package@version target. Throws on
 * malformed input so the runner never spawns a partial command.
 */
export function buildNpmInstallArgs({ packageName, version, registry } = {}) {
  if (typeof packageName !== 'string' || !packageName.startsWith(PUBLISH_SCOPE_PREFIX)) {
    throw new Error(
      `buildNpmInstallArgs: packageName must start with ${PUBLISH_SCOPE_PREFIX} (got ${JSON.stringify(packageName)}).`,
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
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--registry',
    registry,
    `${packageName}@${version}`,
  ]);
}

/**
 * Resolve the path to the installed bin under a consumer's
 * `node_modules/.bin/`. Always uses `plccopilot[.cmd]` because that's
 * the only bin name the CLI declares.
 */
export function buildInstalledBinPath(consumerDir, platform = process.platform) {
  if (typeof consumerDir !== 'string' || consumerDir.length === 0) {
    throw new Error('buildInstalledBinPath: consumerDir must be a non-empty string.');
  }
  const name = platform === 'win32' ? 'plccopilot.cmd' : 'plccopilot';
  return join(consumerDir, 'node_modules', '.bin', name);
}

// ---------------------------------------------------------------------------
// Failure detection
// ---------------------------------------------------------------------------

const NOT_FOUND_PATTERNS = Object.freeze([
  /\bE404\b/i,
  /404 Not Found/i,
  /not in this registry/i,
  /no matching version/i,
  /is not in the npm registry/i,
]);

/**
 * Detect whether an `npm install` failure looks like a "package not
 * yet published" / "no matching version" 404. Used by the runner to
 * print a friendlier error before the first real publish, but does
 * not convert the failure into success.
 */
export function isNpmNotFoundError(stderr, stdout) {
  const haystack = `${typeof stderr === 'string' ? stderr : ''}\n${typeof stdout === 'string' ? stdout : ''}`;
  return NOT_FOUND_PATTERNS.some((rx) => rx.test(haystack));
}

/**
 * Format a spawnSync result for human-readable error output. Always
 * truncates large stdout/stderr to keep failure messages legible in
 * GitHub Actions logs.
 */
export function summarizeSpawnFailure(label, result, max = 600) {
  function trim(text) {
    if (typeof text !== 'string' || text.length === 0) return '<empty>';
    return text.length <= max ? text : `${text.slice(0, max)}…(truncated)`;
  }
  const status = result?.error
    ? `error=${result.error.message ?? String(result.error)}`
    : `status=${result?.status ?? '<null>'}`;
  return (
    `${label} failed (${status})\n` +
    `  stdout: ${trim(result?.stdout)}\n` +
    `  stderr: ${trim(result?.stderr)}`
  );
}
