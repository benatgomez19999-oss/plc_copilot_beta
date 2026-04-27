// Sprint 69 — pure helpers behind `pnpm release:github` and the
// `Create GitHub Release` workflow.
//
// This lib never touches the network. It covers:
//   - argv parsing (--version / --tag / --confirm / --validate-only / --json / --help)
//   - input validation against the workspace + (in real mode) the
//     confirmation string contract
//   - release-notes scan: the docs/releases/<version>.md companion must
//     match the post-promotion state we already record elsewhere — no
//     "pending", no "Do not promote to latest yet", every package + the
//     `latest` tag must be visible.
//   - `gh release create` argv builder (frozen array, deterministic)
//   - assertNoNpmMutationSurface: defence-in-depth check the runner uses
//     before spawning `gh`; refuses to spawn anything containing `publish`,
//     `dist-tag`, or `npm` so a mis-wired call site can never mutate npm
//     from the GitHub-release path.
//
// CRITICAL: this lib has no codepath that builds an npm argv. The runner
// only ever spawns `gh`. The workflow YAML has no `npm publish` /
// `npm dist-tag` shell line either; tests pin both halves.

import {
  EXPECTED_PACKAGE_NAMES,
  RELEASE_PUBLISH_ORDER,
  parseSemver,
} from './release-plan-lib.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GITHUB_RELEASE_TAG_PREFIX = 'v';
export const GITHUB_RELEASE_DEFAULT_TITLE_PREFIX = 'PLC Copilot';
export const GITHUB_RELEASE_PACKAGE_ORDER = Object.freeze([...RELEASE_PUBLISH_ORDER]);

/**
 * Returns the literal confirmation string a real-mode invocation must
 * pass to `--confirm`. Exact byte-for-byte match required — same
 * contract pattern as `release:publish-real` (Sprint 63) and
 * `release:promote-latest` (Sprint 68). Different verbs so an operator
 * can't accidentally cross-paste a confirm from one workflow into
 * another.
 */
export function expectedGithubReleaseConfirmation(version) {
  return `create GitHub release ${GITHUB_RELEASE_TAG_PREFIX}${version}`;
}

/**
 * Returns the canonical tag name for a given version. Sprint 69 always
 * uses `v<version>` — anything else is rejected up-front.
 */
export function expectedGithubReleaseTag(version) {
  return `${GITHUB_RELEASE_TAG_PREFIX}${version}`;
}

/**
 * Returns the canonical release title.
 */
export function expectedGithubReleaseTitle(version) {
  return `${GITHUB_RELEASE_DEFAULT_TITLE_PREFIX} ${expectedGithubReleaseTag(version)}`;
}

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

function makeIssue(code, message, recommendation) {
  return { level: 'error', code, message, recommendation: recommendation ?? null };
}

/**
 * Parse the runner's argv. Recognised flags:
 *   --version X.Y.Z
 *   --tag    vX.Y.Z
 *   --confirm "create GitHub release vX.Y.Z"
 *   --notes-file PATH    (overrides docs/releases/<version>.md)
 *   --validate-only
 *   --json
 *   --help / -h
 *
 * Defence-in-depth: any flag that hints at npm mutation is rejected
 * at parse time (this runner never mutates npm).
 *
 * Returns `{ options, errors }`. Errors carry argv-level codes
 * (GITHUB_RELEASE_ARG_*); semantic validation lives in
 * `validateGithubReleaseInputs`.
 */
export function parseGithubReleaseArgs(argv) {
  if (!Array.isArray(argv)) {
    return {
      options: null,
      errors: [makeIssue('GITHUB_RELEASE_ARG_INVALID', 'argv must be an array.')],
    };
  }
  const options = {
    version: null,
    tag: null,
    confirm: '',
    notesFile: null,
    validateOnly: false,
    json: false,
    help: false,
  };
  const errors = [];

  function takeValue(flag, i) {
    const next = argv[i + 1];
    if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
      errors.push(
        makeIssue('GITHUB_RELEASE_ARG_MISSING_VALUE', `${flag} requires a value.`),
      );
      return { value: null, consume: 0 };
    }
    return { value: next, consume: 1 };
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') {
      errors.push(
        makeIssue('GITHUB_RELEASE_ARG_INVALID', 'arguments must be strings.'),
      );
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
    } else if (a === '--tag') {
      const r = takeValue('--tag', i);
      options.tag = r.value;
      i += r.consume;
    } else if (a.startsWith('--tag=')) {
      options.tag = a.slice('--tag='.length);
    } else if (a === '--confirm') {
      const next = argv[i + 1];
      if (next === undefined) {
        errors.push(
          makeIssue(
            'GITHUB_RELEASE_ARG_MISSING_VALUE',
            '--confirm requires the literal confirmation string.',
          ),
        );
      } else {
        options.confirm = next;
        i++;
      }
    } else if (a.startsWith('--confirm=')) {
      options.confirm = a.slice('--confirm='.length);
    } else if (a === '--notes-file') {
      const r = takeValue('--notes-file', i);
      options.notesFile = r.value;
      i += r.consume;
    } else if (a.startsWith('--notes-file=')) {
      options.notesFile = a.slice('--notes-file='.length);
    } else if (
      a === '--publish' ||
      a === '--no-dry-run' ||
      a === '--dry-run' ||
      a === '-y' ||
      a === '--yes' ||
      a === '--dist-tag'
    ) {
      // Defence-in-depth: this runner never mutates npm. Any flag that
      // hints at npm publish or dist-tag is rejected at parse time.
      errors.push(
        makeIssue(
          'GITHUB_RELEASE_ARG_UNKNOWN',
          `${a} is not a valid release:github flag (this runner never mutates npm).`,
          'Use pnpm release:publish-real or pnpm release:promote-latest for npm flows.',
        ),
      );
    } else {
      errors.push(
        makeIssue('GITHUB_RELEASE_ARG_UNKNOWN', `unknown argument: ${JSON.stringify(a)}`),
      );
    }
  }

  return { options, errors };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Apply defaults and validate inputs. In `validateOnly` mode the
 * confirm check is skipped so CI / local preflight can fail fast on a
 * misaligned version without having to type the confirmation string.
 */
export function validateGithubReleaseInputs(rawOptions, workspace) {
  const overrides = {};
  for (const [k, v] of Object.entries(rawOptions ?? {})) {
    if (v !== null && v !== undefined) overrides[k] = v;
  }
  const options = {
    json: false,
    help: false,
    validateOnly: false,
    confirm: '',
    notesFile: null,
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
        'GITHUB_RELEASE_VERSION_REQUIRED',
        '--version is required.',
        'Pass --version X.Y.Z (must equal every package.json version).',
      ),
    );
  } else if (parseSemver(options.version) === null) {
    issues.push(
      makeIssue(
        'GITHUB_RELEASE_VERSION_INVALID',
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
            'GITHUB_RELEASE_VERSION_MISMATCH',
            `${EXPECTED_PACKAGE_NAMES[c.dir]} reports version ${JSON.stringify(pkgVersion)}, --version was ${JSON.stringify(options.version)}.`,
            'Tag only the version that matches every package.json. Bump the workspace before tagging a different version.',
          ),
        );
      }
    }
  }

  // Tag must equal v<version>. We default it to that, and reject any
  // override that disagrees.
  const expectedTag =
    typeof options.version === 'string' ? expectedGithubReleaseTag(options.version) : null;
  if (options.tag === null || options.tag === undefined) {
    options.tag = expectedTag;
  }
  if (typeof options.tag !== 'string' || options.tag.length === 0) {
    issues.push(
      makeIssue('GITHUB_RELEASE_TAG_REQUIRED', '--tag is required.'),
    );
  } else if (expectedTag && options.tag !== expectedTag) {
    issues.push(
      makeIssue(
        'GITHUB_RELEASE_TAG_MISMATCH',
        `--tag ${JSON.stringify(options.tag)} does not match the canonical tag ${JSON.stringify(expectedTag)}.`,
        `Pass --tag ${expectedTag} (Sprint 69 hardcodes the v<version> shape).`,
      ),
    );
  }

  if (!options.validateOnly) {
    const expectedConfirm =
      typeof options.version === 'string'
        ? expectedGithubReleaseConfirmation(options.version)
        : null;
    if (typeof options.confirm !== 'string' || options.confirm.length === 0) {
      issues.push(
        makeIssue(
          'GITHUB_RELEASE_CONFIRM_REQUIRED',
          '--confirm is required for a real GitHub release creation.',
          expectedConfirm
            ? `Pass --confirm "${expectedConfirm}".`
            : 'Pass --confirm "create GitHub release v<version>".',
        ),
      );
    } else if (expectedConfirm && options.confirm !== expectedConfirm) {
      issues.push(
        makeIssue(
          'GITHUB_RELEASE_CONFIRM_MISMATCH',
          '--confirm did not match the expected string.',
          `Expected exactly: ${expectedConfirm}`,
        ),
      );
    }
  }

  return { options, issues };
}

// ---------------------------------------------------------------------------
// Release-notes scan
// ---------------------------------------------------------------------------

/**
 * Banned phrases for the release notes file. These are the safety
 * phrases the docs-contract suite explicitly forbids in the
 * post-promotion state — checking them here means the GitHub Release
 * flow refuses to start if someone partially rolled the doc back.
 */
const RELEASE_NOTES_FORBIDDEN_PHRASES = Object.freeze([
  'planned first npm release — pending',
  'do not promote to latest yet',
]);

/**
 * Validate that the release-notes markdown is in the post-promotion
 * shape Sprint 69 expects:
 *   - mentions the version, the `latest` dist-tag, and every package
 *   - does not contain any of the historical "pending" phrases
 * Returns an array of issues; empty means the notes are good to use
 * as the GitHub Release body.
 */
export function validateReleaseNotesForGithubRelease(markdown, { version } = {}) {
  const issues = [];
  if (typeof markdown !== 'string' || markdown.length === 0) {
    issues.push(
      makeIssue(
        'GITHUB_RELEASE_NOTES_MISSING',
        `release notes content is empty${version ? ` (expected docs/releases/${version}.md)` : ''}.`,
      ),
    );
    return issues;
  }
  if (typeof version === 'string' && version.length > 0) {
    if (!markdown.includes(version)) {
      issues.push(
        makeIssue(
          'GITHUB_RELEASE_NOTES_VERSION_MISSING',
          `release notes do not mention version ${version}.`,
        ),
      );
    }
  }

  const lower = markdown.toLowerCase();
  for (const phrase of RELEASE_NOTES_FORBIDDEN_PHRASES) {
    if (lower.includes(phrase)) {
      issues.push(
        makeIssue(
          'GITHUB_RELEASE_NOTES_PENDING_STATUS',
          `release notes still contain the historical phrase ${JSON.stringify(phrase)}.`,
          'Update the release notes to the post-promotion shape before creating the GitHub Release.',
        ),
      );
    }
  }

  if (!/\blatest\b/.test(lower)) {
    issues.push(
      makeIssue(
        'GITHUB_RELEASE_NOTES_LATEST_MISSING',
        'release notes do not mention the `latest` dist-tag.',
        'The 0.1.0 release notes must record that the version is on `latest`.',
      ),
    );
  }

  for (const name of GITHUB_RELEASE_PACKAGE_ORDER) {
    if (!markdown.includes(name)) {
      issues.push(
        makeIssue(
          'GITHUB_RELEASE_NOTES_PACKAGE_MISSING',
          `release notes do not mention ${name}.`,
        ),
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Asset validation
// ---------------------------------------------------------------------------

/**
 * Sprint 69 attaches the six release tarballs and the manifest produced
 * by `release:pack-artifacts` to the GitHub Release. The runner calls
 * this against the on-disk paths before building the gh argv. Pass
 * `existsFn` (defaults to `() => true`) so tests can simulate missing
 * files without filesystem mocks.
 */
export function validateGithubReleaseAssets(
  { tarballPaths, manifestPath } = {},
  { existsFn = () => true } = {},
) {
  const issues = [];
  if (!Array.isArray(tarballPaths)) {
    issues.push(
      makeIssue(
        'GITHUB_RELEASE_ASSET_MISSING',
        'tarballPaths must be an array of .tgz paths.',
      ),
    );
    return issues;
  }
  if (tarballPaths.length !== GITHUB_RELEASE_PACKAGE_ORDER.length) {
    issues.push(
      makeIssue(
        'GITHUB_RELEASE_ASSET_MISSING',
        `expected exactly ${GITHUB_RELEASE_PACKAGE_ORDER.length} tarball(s), got ${tarballPaths.length}.`,
        'Run `pnpm release:pack-artifacts --out <dir> --clean` first.',
      ),
    );
  }
  for (const p of tarballPaths) {
    if (typeof p !== 'string' || !p.endsWith('.tgz')) {
      issues.push(
        makeIssue(
          'GITHUB_RELEASE_ASSET_MISSING',
          `tarball path ${JSON.stringify(p)} is not a .tgz path.`,
        ),
      );
      continue;
    }
    if (!existsFn(p)) {
      issues.push(
        makeIssue(
          'GITHUB_RELEASE_ASSET_MISSING',
          `tarball ${p} does not exist on disk.`,
        ),
      );
    }
  }
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
    issues.push(
      makeIssue('GITHUB_RELEASE_ASSET_MISSING', 'manifestPath is required.'),
    );
  } else if (!manifestPath.endsWith('manifest.json')) {
    issues.push(
      makeIssue(
        'GITHUB_RELEASE_ASSET_MISSING',
        `manifestPath ${JSON.stringify(manifestPath)} must end with manifest.json.`,
      ),
    );
  } else if (!existsFn(manifestPath)) {
    issues.push(
      makeIssue(
        'GITHUB_RELEASE_ASSET_MISSING',
        `manifest.json ${manifestPath} does not exist on disk.`,
      ),
    );
  }
  return issues;
}

// ---------------------------------------------------------------------------
// gh argv builder
// ---------------------------------------------------------------------------

/**
 * Build the canonical argv for `gh release create`. Returns a frozen
 * array. Order is fixed (subcommand, tag, asset paths, --title,
 * --notes-file). The runner spawns `gh` with this argv; nothing else
 * is ever passed.
 *
 * Validation:
 *   - `tag` must equal `v<version>` (per `expectedGithubReleaseTag`)
 *   - `notesFile` must end with `.md` and be a non-empty string
 *   - `assetPaths` must be a non-empty array of `.tgz` / `.json` paths
 *   - `title` defaults to `expectedGithubReleaseTitle(version)` if omitted
 */
export function buildGhReleaseCreateArgs({
  version,
  tag,
  title,
  notesFile,
  assetPaths,
} = {}) {
  if (typeof version !== 'string' || parseSemver(version) === null) {
    throw new Error(
      `buildGhReleaseCreateArgs: version must be strict X.Y.Z (got ${JSON.stringify(version)}).`,
    );
  }
  const expectedTag = expectedGithubReleaseTag(version);
  if (typeof tag !== 'string' || tag !== expectedTag) {
    throw new Error(
      `buildGhReleaseCreateArgs: tag must equal ${JSON.stringify(expectedTag)} (got ${JSON.stringify(tag)}).`,
    );
  }
  if (typeof notesFile !== 'string' || !notesFile.endsWith('.md')) {
    throw new Error(
      `buildGhReleaseCreateArgs: notesFile must be a .md path (got ${JSON.stringify(notesFile)}).`,
    );
  }
  if (!Array.isArray(assetPaths) || assetPaths.length === 0) {
    throw new Error(
      `buildGhReleaseCreateArgs: assetPaths must be a non-empty array.`,
    );
  }
  for (const a of assetPaths) {
    if (typeof a !== 'string' || a.length === 0) {
      throw new Error(
        `buildGhReleaseCreateArgs: every asset path must be a non-empty string (got ${JSON.stringify(a)}).`,
      );
    }
    if (!a.endsWith('.tgz') && !a.endsWith('.json')) {
      throw new Error(
        `buildGhReleaseCreateArgs: asset paths must be .tgz or .json (got ${JSON.stringify(a)}).`,
      );
    }
  }
  const finalTitle =
    typeof title === 'string' && title.length > 0
      ? title
      : expectedGithubReleaseTitle(version);

  return Object.freeze([
    'release',
    'create',
    tag,
    ...assetPaths,
    '--title',
    finalTitle,
    '--notes-file',
    notesFile,
  ]);
}

/**
 * `gh release view <tag>` — used by the runner to detect "does the
 * release already exist?" without mutating anything.
 */
export function buildGhReleaseViewArgs({ tag } = {}) {
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new Error(
      `buildGhReleaseViewArgs: tag must be a non-empty string (got ${JSON.stringify(tag)}).`,
    );
  }
  return Object.freeze(['release', 'view', tag]);
}

// ---------------------------------------------------------------------------
// Final assertion: NO npm mutation surface
// ---------------------------------------------------------------------------

/**
 * Defence-in-depth assertion the runner uses before spawning `gh`.
 * Confirms an argv array does not contain any npm-mutation token.
 * Returns true on a safe argv, throws otherwise — never returns false.
 *
 * This is the GitHub-side analogue of `assertNoPublishSurface` in the
 * promote-latest lib: even though `gh` doesn't talk to npm, the check
 * exists so a future refactor that accidentally tries to run an npm
 * command from this script blows up instead of silently mutating the
 * registry.
 */
export function assertNoNpmMutationSurface(argv) {
  if (!Array.isArray(argv)) {
    throw new Error('assertNoNpmMutationSurface: argv must be an array.');
  }
  for (const a of argv) {
    if (typeof a !== 'string') {
      throw new Error(
        'assertNoNpmMutationSurface: every argv entry must be a string.',
      );
    }
    if (
      a === 'publish' ||
      a === '--publish' ||
      a === '--no-dry-run' ||
      a === 'dist-tag' ||
      a === 'npm'
    ) {
      throw new Error(
        `assertNoNpmMutationSurface: refusing argv with npm-mutation surface (${JSON.stringify(a)}).`,
      );
    }
  }
  return true;
}
