// Sprint 65 — pure helpers behind `pnpm release:npm-view`.
//
// The runner shells out to `npm view <pkg>@<spec> --json --registry <url>`
// for each release candidate; this lib covers argv parsing, command
// building, JSON shape parsing, and post-validation. Network is the
// runner's job — every helper here is testable without a registry.

import { EXPECTED_PACKAGE_NAMES, parseSemver } from './release-plan-lib.mjs';

export const NPM_VIEW_DEFAULTS = Object.freeze({
  registry: 'https://registry.npmjs.org',
});

const PUBLISH_SCOPE_PREFIX = '@plccopilot/';
const VALID_NPM_TAGS = Object.freeze(['next', 'latest', 'beta']);

function makeIssue(code, packageName, message, recommendation) {
  return {
    level: 'error',
    code,
    package: packageName ?? null,
    message,
    recommendation: recommendation ?? null,
  };
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/**
 * Parse the runner's argv. Recognised flags:
 *   --version X.Y.Z
 *   --registry URL
 *   --tag <next|latest|beta>
 *   --json
 *   --help / -h
 */
export function parseNpmViewArgs(argv) {
  if (!Array.isArray(argv)) {
    return {
      options: null,
      errors: [makeIssue('NPM_VIEW_ARGV_INVALID', null, 'argv must be an array.', null)],
    };
  }
  const options = {
    version: null,
    registry: null,
    tag: null,
    json: false,
    help: false,
  };
  const errors = [];

  function takeValue(flag, i) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      errors.push(makeIssue('NPM_VIEW_FLAG_MISSING_VALUE', null, `${flag} requires a value.`));
      return { value: null, consume: 0 };
    }
    return { value: next, consume: 1 };
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') {
      errors.push(makeIssue('NPM_VIEW_ARG_INVALID', null, 'arguments must be strings.'));
      continue;
    }
    if (a === '--help' || a === '-h') options.help = true;
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
    } else if (a === '--tag') {
      const r = takeValue('--tag', i);
      options.tag = r.value;
      i += r.consume;
    } else if (a.startsWith('--tag=')) {
      options.tag = a.slice('--tag='.length);
    } else {
      errors.push(
        makeIssue(
          'NPM_VIEW_UNKNOWN_FLAG',
          null,
          `unknown argument: ${JSON.stringify(a)}`,
          'Run --help for the supported flag list.',
        ),
      );
    }
  }

  return { options, errors };
}

// ---------------------------------------------------------------------------
// option validator
// ---------------------------------------------------------------------------

export function validateNpmViewOptions(rawOptions, workspace) {
  const overrides = {};
  for (const [k, v] of Object.entries(rawOptions ?? {})) {
    if (v !== null && v !== undefined) overrides[k] = v;
  }
  const options = {
    ...NPM_VIEW_DEFAULTS,
    json: false,
    help: false,
    tag: null,
    ...overrides,
  };
  const issues = [];

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
        'NPM_VIEW_VERSION_REQUIRED',
        null,
        '--version is required (workspace did not have a single shared version).',
        'Pass --version X.Y.Z or align the workspace first.',
      ),
    );
  } else if (parseSemver(options.version) === null) {
    issues.push(
      makeIssue(
        'NPM_VIEW_VERSION_INVALID',
        null,
        `--version ${JSON.stringify(options.version)} is not strict X.Y.Z.`,
      ),
    );
  }

  if (typeof options.registry !== 'string' || !/^https?:\/\//.test(options.registry)) {
    issues.push(
      makeIssue(
        'NPM_VIEW_REGISTRY_INVALID',
        null,
        '--registry must be an http(s) URL.',
      ),
    );
  }

  if (options.tag !== null && options.tag !== undefined) {
    if (typeof options.tag !== 'string' || !VALID_NPM_TAGS.includes(options.tag)) {
      issues.push(
        makeIssue(
          'NPM_VIEW_TAG_INVALID',
          null,
          `--tag must be one of ${VALID_NPM_TAGS.join('|')} (got ${JSON.stringify(options.tag)}).`,
        ),
      );
    }
  }

  return { options, issues };
}

// ---------------------------------------------------------------------------
// command builders
// ---------------------------------------------------------------------------

/**
 * `npm view <pkg>@<version> --json --registry <url>`. Throws on
 * malformed input so the runner never spawns a half-built command.
 */
export function buildNpmViewPackageArgs({ packageName, version, registry } = {}) {
  if (typeof packageName !== 'string' || !packageName.startsWith(PUBLISH_SCOPE_PREFIX)) {
    throw new Error(
      `buildNpmViewPackageArgs: packageName must start with ${PUBLISH_SCOPE_PREFIX} (got ${JSON.stringify(packageName)}).`,
    );
  }
  if (typeof version !== 'string' || parseSemver(version) === null) {
    throw new Error(
      `buildNpmViewPackageArgs: version must be strict X.Y.Z (got ${JSON.stringify(version)}).`,
    );
  }
  if (typeof registry !== 'string' || !/^https?:\/\//.test(registry)) {
    throw new Error(
      `buildNpmViewPackageArgs: registry must be a http(s) URL (got ${JSON.stringify(registry)}).`,
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
 * `npm view <pkg>@<tag> version --json --registry <url>` — narrows the
 * fetched payload to a single string so we can compare it against the
 * expected version cheaply.
 */
export function buildNpmViewTagArgs({ packageName, tag, registry } = {}) {
  if (typeof packageName !== 'string' || !packageName.startsWith(PUBLISH_SCOPE_PREFIX)) {
    throw new Error(
      `buildNpmViewTagArgs: packageName must start with ${PUBLISH_SCOPE_PREFIX} (got ${JSON.stringify(packageName)}).`,
    );
  }
  if (typeof tag !== 'string' || !VALID_NPM_TAGS.includes(tag)) {
    throw new Error(
      `buildNpmViewTagArgs: tag must be one of ${VALID_NPM_TAGS.join('|')} (got ${JSON.stringify(tag)}).`,
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

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

/**
 * `npm view --json` may emit a JSON object (full version metadata),
 * a JSON-quoted string (single-field view), an array (when querying
 * multiple versions), or even mixed warning prose followed by the
 * payload. Tolerate the prefix-warnings case, return null on garbage.
 */
export function parseNpmViewJson(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    // Tolerate leading non-JSON garbage by scanning to the first
    // structural marker.
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

// ---------------------------------------------------------------------------
// validators
// ---------------------------------------------------------------------------

export function validateNpmViewPackageMetadata(metadata, expected) {
  const issues = [];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    issues.push(
      makeIssue(
        'NPM_VIEW_NO_OBJECT',
        expected.name,
        'npm view did not return a JSON object.',
        'Run the command manually to inspect the raw output.',
      ),
    );
    return issues;
  }
  if (metadata.name !== expected.name) {
    issues.push(
      makeIssue(
        'NPM_VIEW_NAME_MISMATCH',
        expected.name,
        `npm reports name=${JSON.stringify(metadata.name)} (expected ${expected.name}).`,
      ),
    );
  }
  if (metadata.version !== expected.version) {
    issues.push(
      makeIssue(
        'NPM_VIEW_VERSION_MISMATCH',
        expected.name,
        `npm reports version=${JSON.stringify(metadata.version)} (expected ${expected.version}).`,
      ),
    );
  }
  const dist = metadata.dist;
  if (!dist || typeof dist !== 'object') {
    issues.push(
      makeIssue('NPM_VIEW_DIST_MISSING', expected.name, 'npm view payload missing dist{}.'),
    );
  } else {
    if (typeof dist.tarball !== 'string' || dist.tarball.length === 0) {
      issues.push(
        makeIssue(
          'NPM_VIEW_DIST_TARBALL_MISSING',
          expected.name,
          'dist.tarball is missing or empty.',
        ),
      );
    }
    if (typeof dist.integrity !== 'string' || dist.integrity.length === 0) {
      issues.push(
        makeIssue(
          'NPM_VIEW_DIST_INTEGRITY_MISSING',
          expected.name,
          'dist.integrity (sha512 hash) is missing or empty.',
        ),
      );
    }
    // dist.shasum is optional — older registries omit it, newer ones
    // include it. We do not block on its absence.
  }
  return issues;
}

export function validateNpmViewTagVersion(value, expected) {
  if (value === expected.version) return [];
  return [
    makeIssue(
      'NPM_VIEW_TAG_VERSION_MISMATCH',
      expected.name,
      `tag ${JSON.stringify(expected.tag)} resolves to ${JSON.stringify(value)} (expected ${expected.version}).`,
      `Run \`npm dist-tag add ${expected.name}@${expected.version} ${expected.tag}\` after the publish has been verified.`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// failure detection
// ---------------------------------------------------------------------------

const NOT_FOUND_PATTERNS = Object.freeze([
  /\bE404\b/i,
  /404 Not Found/i,
  /no such package available/i,
  /no matching version/i,
  /is not in the npm registry/i,
]);

export function isNpmViewNotFoundError(stderr, stdout) {
  const text = `${typeof stderr === 'string' ? stderr : ''}\n${typeof stdout === 'string' ? stdout : ''}`;
  return NOT_FOUND_PATTERNS.some((rx) => rx.test(text));
}

// ---------------------------------------------------------------------------
// expectation builder
// ---------------------------------------------------------------------------

/**
 * Build an `expected` object for one publish candidate so the runner
 * doesn't have to keep dir → name maps in scope.
 */
export function expectedForCandidate(dir, version, tag) {
  const name = EXPECTED_PACKAGE_NAMES[dir];
  if (!name) throw new Error(`expectedForCandidate: unknown release dir ${JSON.stringify(dir)}`);
  return { name, version, tag: tag ?? null };
}
