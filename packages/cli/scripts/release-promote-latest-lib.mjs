// Sprint 68 — pure helpers behind `pnpm release:promote-latest`.
//
// The runner mutates the npm registry only via `npm dist-tag add`.
// This lib covers argv parsing, command building, registry-output
// parsing, and per-package validation. Network is the runner's job;
// the helpers are unit-testable without the registry.
//
// CRITICAL: there is no codepath here that calls or builds an
// `npm publish` argv. Sprint 68 promotes existing tarballs by name,
// it does not republish them. The runner enforces this; the lib also
// keeps the publish surface out by construction (no command builder
// that emits `publish`).

import {
  EXPECTED_PACKAGE_NAMES,
  RELEASE_PUBLISH_ORDER,
  parseSemver,
} from './release-plan-lib.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROMOTE_SOURCE_TAG = 'next';
export const PROMOTE_TARGET_TAG = 'latest';
export const PROMOTE_SCOPE = '@plccopilot';
export const PROMOTE_DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const PROMOTE_REQUIRED_ENV_VARS = Object.freeze(['NODE_AUTH_TOKEN']);

/**
 * Promote order mirrors the publish order. We move the `latest` tag in
 * the same direction the publish workflow moved tarballs so a partial
 * failure leaves consumers in a "newer-deps-not-latest-yet" rather
 * than a "consumer-references-missing" state.
 */
export const PROMOTE_PACKAGE_ORDER = Object.freeze([...RELEASE_PUBLISH_ORDER]);

/**
 * Returns the literal confirmation string a real-mode invocation must
 * pass to `--confirm`. Exact match required — no partial / regex /
 * case-insensitive comparison. Mirrors `release:publish-real`'s
 * confirmation contract from sprint 63.
 */
export function expectedPromoteConfirmation(version) {
  return `promote ${PROMOTE_SCOPE} ${version} to ${PROMOTE_TARGET_TAG}`;
}

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

function makeIssue(code, message, recommendation) {
  return { level: 'error', code, message, recommendation: recommendation ?? null };
}

/**
 * Parse the runner's argv. Recognised flags:
 *   --version X.Y.Z
 *   --registry URL
 *   --confirm "promote @plccopilot <version> to latest"
 *   --validate-only
 *   --json
 *   --help / -h
 *
 * Returns `{ options, errors }`. Errors carry argv-level codes
 * (PROMOTE_ARG_*); semantic validation lives in
 * `validatePromoteInputs`.
 */
export function parsePromoteLatestArgs(argv) {
  if (!Array.isArray(argv)) {
    return {
      options: null,
      errors: [makeIssue('PROMOTE_ARG_INVALID', 'argv must be an array.')],
    };
  }
  const options = {
    version: null,
    registry: null,
    confirm: '',
    validateOnly: false,
    json: false,
    help: false,
  };
  const errors = [];

  function takeValue(flag, i) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      errors.push(makeIssue('PROMOTE_ARG_MISSING_VALUE', `${flag} requires a value.`));
      return { value: null, consume: 0 };
    }
    return { value: next, consume: 1 };
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') {
      errors.push(makeIssue('PROMOTE_ARG_INVALID', 'arguments must be strings.'));
      continue;
    }
    if (a === '--help' || a === '-h') options.help = true;
    else if (a === '--validate-only') options.validateOnly = true;
    else if (a === '--json') options.json = true;
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
    } else if (a === '--confirm') {
      const next = argv[i + 1];
      if (next === undefined) {
        errors.push(
          makeIssue('PROMOTE_ARG_MISSING_VALUE', '--confirm requires the literal confirmation string.'),
        );
      } else {
        options.confirm = next;
        i++;
      }
    } else if (a.startsWith('--confirm=')) {
      options.confirm = a.slice('--confirm='.length);
    } else if (a === '--publish' || a === '--no-dry-run' || a === '-y' || a === '--yes') {
      // Defence-in-depth: the runner is for dist-tag promotion only.
      // Any flag that hints at publishing is rejected up-front.
      errors.push(
        makeIssue(
          'PROMOTE_ARG_UNKNOWN',
          `${a} is not a valid release:promote-latest flag (this runner never publishes).`,
          'Use pnpm release:publish-real for publish flows.',
        ),
      );
    } else {
      errors.push(makeIssue('PROMOTE_ARG_UNKNOWN', `unknown argument: ${JSON.stringify(a)}`));
    }
  }

  return { options, errors };
}

// ---------------------------------------------------------------------------
// Option validator
// ---------------------------------------------------------------------------

/**
 * Apply defaults and validate inputs. In `validateOnly` mode the
 * confirm + token checks are intentionally skipped so CI / local
 * preflight can fail fast on a misaligned version without entering
 * the protected environment.
 */
export function validatePromoteInputs(rawOptions, workspace) {
  const overrides = {};
  for (const [k, v] of Object.entries(rawOptions ?? {})) {
    if (v !== null && v !== undefined) overrides[k] = v;
  }
  const options = {
    registry: PROMOTE_DEFAULT_REGISTRY,
    json: false,
    help: false,
    validateOnly: false,
    confirm: '',
    ...overrides,
  };
  const issues = [];

  // Version: derive from workspace if not given.
  if (!options.version && workspace) {
    const versions = new Set();
    for (const c of workspace.candidates) {
      if (c.missing || !c.pkg) continue;
      const v = c.pkg.parsed?.version;
      if (typeof v === 'string') versions.add(v);
    }
    if (versions.size === 1) options.version = [...versions][0];
  }

  if (typeof options.version !== 'string' || options.version.length === 0) {
    issues.push(
      makeIssue(
        'PROMOTE_INPUT_VERSION_REQUIRED',
        '--version is required.',
        'Pass --version X.Y.Z (must equal every package.json version).',
      ),
    );
  } else if (parseSemver(options.version) === null) {
    issues.push(
      makeIssue(
        'PROMOTE_INPUT_VERSION_INVALID',
        `--version ${JSON.stringify(options.version)} is not strict X.Y.Z.`,
        'Use a strict semver such as 0.1.0.',
      ),
    );
  } else if (workspace) {
    for (const c of workspace.candidates) {
      if (c.missing || !c.pkg) continue;
      const pkgVersion = c.pkg.parsed?.version;
      if (pkgVersion !== options.version) {
        issues.push(
          makeIssue(
            'PROMOTE_INPUT_VERSION_MISMATCH',
            `${EXPECTED_PACKAGE_NAMES[c.dir]} reports version ${JSON.stringify(pkgVersion)}, --version was ${JSON.stringify(options.version)}.`,
            'Promote only the version that matches every package.json. Bump the workspace before promoting a different version.',
          ),
        );
      }
    }
  }

  if (typeof options.registry !== 'string' || !/^https?:\/\//.test(options.registry)) {
    issues.push(
      makeIssue(
        'PROMOTE_INPUT_REGISTRY_INVALID',
        '--registry must be an http(s) URL.',
      ),
    );
  }

  if (!options.validateOnly) {
    const expectedConfirm =
      typeof options.version === 'string' ? expectedPromoteConfirmation(options.version) : null;
    if (typeof options.confirm !== 'string' || options.confirm.length === 0) {
      issues.push(
        makeIssue(
          'PROMOTE_INPUT_CONFIRM_REQUIRED',
          '--confirm is required for a real promotion.',
          expectedConfirm
            ? `Pass --confirm "${expectedConfirm}".`
            : 'Pass --confirm "promote @plccopilot <version> to latest".',
        ),
      );
    } else if (expectedConfirm && options.confirm !== expectedConfirm) {
      issues.push(
        makeIssue(
          'PROMOTE_INPUT_CONFIRM_MISMATCH',
          '--confirm did not match the expected string.',
          `Expected exactly: ${expectedConfirm}`,
        ),
      );
    }
    const env = options.env ?? {};
    for (const name of PROMOTE_REQUIRED_ENV_VARS) {
      if (typeof env[name] !== 'string' || env[name].length === 0) {
        issues.push(
          makeIssue(
            'PROMOTE_ENV_VAR_MISSING',
            `environment variable ${name} is required for a real promotion.`,
            'Run from the GitHub Actions `npm-publish` environment with the NPM_TOKEN secret in scope.',
          ),
        );
      }
    }
  }

  return { options, issues };
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

const SCOPE_PREFIX = `${PROMOTE_SCOPE}/`;
const VALID_VIEW_TAGS = Object.freeze(['next', 'latest', 'beta']);

/**
 * `npm view <pkg>@<tag> version --json --registry <url>` — narrows
 * the payload to a single string so callers can parse with
 * `parseNpmJson`.
 */
export function buildNpmViewTagArgs({ packageName, tag, registry } = {}) {
  if (typeof packageName !== 'string' || !packageName.startsWith(SCOPE_PREFIX)) {
    throw new Error(
      `buildNpmViewTagArgs: packageName must start with ${SCOPE_PREFIX} (got ${JSON.stringify(packageName)}).`,
    );
  }
  if (typeof tag !== 'string' || !VALID_VIEW_TAGS.includes(tag)) {
    throw new Error(
      `buildNpmViewTagArgs: tag must be one of ${VALID_VIEW_TAGS.join('|')} (got ${JSON.stringify(tag)}).`,
    );
  }
  if (typeof registry !== 'string' || !/^https?:\/\//.test(registry)) {
    throw new Error(
      `buildNpmViewTagArgs: registry must be a http(s) URL (got ${JSON.stringify(registry)}).`,
    );
  }
  return Object.freeze([
    'view',
    `${packageName}@${tag}`,
    'version',
    '--json',
    '--registry',
    registry,
  ]);
}

/**
 * `npm dist-tag add <pkg>@<version> <tag> --registry <url>`. Sprint
 * 68 hardcodes the target tag to `latest`. Throws on any other tag —
 * promotion to anything else (e.g., `beta`) is out of scope and a
 * future sprint will expose a separate command if it's ever needed.
 */
export function buildNpmDistTagAddArgs({ packageName, version, tag, registry } = {}) {
  if (typeof packageName !== 'string' || !packageName.startsWith(SCOPE_PREFIX)) {
    throw new Error(
      `buildNpmDistTagAddArgs: packageName must start with ${SCOPE_PREFIX} (got ${JSON.stringify(packageName)}).`,
    );
  }
  if (typeof version !== 'string' || parseSemver(version) === null) {
    throw new Error(
      `buildNpmDistTagAddArgs: version must be strict X.Y.Z (got ${JSON.stringify(version)}).`,
    );
  }
  if (tag !== PROMOTE_TARGET_TAG) {
    throw new Error(
      `buildNpmDistTagAddArgs: tag must equal "${PROMOTE_TARGET_TAG}" (got ${JSON.stringify(tag)}).`,
    );
  }
  if (typeof registry !== 'string' || !/^https?:\/\//.test(registry)) {
    throw new Error(
      `buildNpmDistTagAddArgs: registry must be a http(s) URL (got ${JSON.stringify(registry)}).`,
    );
  }
  return Object.freeze([
    'dist-tag',
    'add',
    `${packageName}@${version}`,
    tag,
    '--registry',
    registry,
  ]);
}

// ---------------------------------------------------------------------------
// npm output parsing + validation
// ---------------------------------------------------------------------------

const NOT_FOUND_PATTERNS = Object.freeze([
  /\bE404\b/i,
  /404 Not Found/i,
  /no such package available/i,
  /no matching version/i,
  /is not in the npm registry/i,
]);

export function isNpmNotFoundError(stderr, stdout) {
  const text = `${typeof stderr === 'string' ? stderr : ''}\n${typeof stdout === 'string' ? stdout : ''}`;
  return NOT_FOUND_PATTERNS.some((rx) => rx.test(text));
}

/**
 * Parse `npm view ... --json` stdout. Tolerates a leading sequence of
 * `npm warn` / `npm notice` lines (some npm versions still leak them
 * to stdout under `--json`).
 */
export function parseNpmJson(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    let cursor = -1;
    for (const ch of ['"', '{', '[']) {
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
 * Validate that a `npm view <pkg>@<tag> version` payload (a JSON
 * string) matches the expected version. `tag` + `packageName` only
 * decorate the issue codes / messages.
 */
export function validateTagVersion(value, expected) {
  const issues = [];
  if (typeof value !== 'string') {
    issues.push(
      makeIssue(
        expected.tag === PROMOTE_SOURCE_TAG
          ? 'PROMOTE_TAG_SOURCE_MISMATCH'
          : 'PROMOTE_TAG_TARGET_MISMATCH',
        `${expected.packageName}@${expected.tag} did not return a string version (got ${JSON.stringify(value)}).`,
      ),
    );
    return issues;
  }
  if (value !== expected.version) {
    const code =
      expected.tag === PROMOTE_SOURCE_TAG
        ? 'PROMOTE_TAG_SOURCE_MISMATCH'
        : 'PROMOTE_TAG_TARGET_MISMATCH';
    const tip =
      expected.tag === PROMOTE_SOURCE_TAG
        ? `Confirm ${expected.packageName} was actually published at ${expected.version} under ${PROMOTE_SOURCE_TAG} before promoting.`
        : `After a successful promote, ${expected.packageName}@${PROMOTE_TARGET_TAG} must resolve to ${expected.version}. If it does not, re-run \`npm dist-tag add ${expected.packageName}@${expected.version} ${PROMOTE_TARGET_TAG}\` from a trusted shell.`;
    issues.push(
      makeIssue(
        code,
        `${expected.packageName}@${expected.tag} resolves to ${JSON.stringify(value)} (expected ${expected.version}).`,
        tip,
      ),
    );
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Final assertion: NO publish surface
// ---------------------------------------------------------------------------

/**
 * Defence-in-depth assertion the runner uses before spawning a real
 * registry mutation. Confirms an argv array does not contain any
 * publish-related token. Returns true on a safe argv, throws
 * otherwise — never returns false.
 */
export function assertNoPublishSurface(argv) {
  if (!Array.isArray(argv)) {
    throw new Error('assertNoPublishSurface: argv must be an array.');
  }
  for (const a of argv) {
    if (typeof a !== 'string') {
      throw new Error('assertNoPublishSurface: every argv entry must be a string.');
    }
    if (a === 'publish' || a === '--publish' || a === '--no-dry-run') {
      throw new Error(
        `assertNoPublishSurface: refusing argv with publish surface (${JSON.stringify(a)}).`,
      );
    }
  }
  return true;
}
