// Sprint 63 — pure helpers behind the *real* npm publish runner.
//
// Every code path here either validates inputs or builds a fixed
// `npm publish --provenance --access public --tag <tag>` command line.
// The command builder never includes `--dry-run` and never accepts a
// caller-supplied flag list, so there is no escape hatch from "real
// publish" once the runner enters that branch.
//
// The runner consumes:
//   - validatePublishInputs(...) before calling spawn
//   - buildNpmPublishCommand(...) to construct the shell argv
//   - PUBLISH_REQUIRED_ENV_VARS to fail fast if the token is missing

import { EXPECTED_PACKAGE_NAMES, RELEASE_PUBLISH_ORDER, parseSemver } from './release-plan-lib.mjs';

export const VALID_NPM_TAGS = Object.freeze(['next', 'latest', 'beta']);

/**
 * Tokens recognised at the start of a published package's scope.
 * The confirmation string + every published name must use this scope.
 */
export const PUBLISH_SCOPE = '@plccopilot';

/**
 * Process-environment variables the real publish flow REQUIRES. If any
 * of these are missing, the runner must abort before contacting the
 * registry. `NODE_AUTH_TOKEN` is the conventional npm token name; the
 * GitHub Actions workflow injects it from the `NPM_TOKEN` secret.
 */
export const PUBLISH_REQUIRED_ENV_VARS = Object.freeze(['NODE_AUTH_TOKEN']);

/**
 * Returns the literal confirmation string a real-mode invocation must
 * pass to `--confirm`. Exact match required — no partial / regex /
 * case-insensitive comparison.
 */
export function expectedPublishConfirmation(version) {
  return `publish ${PUBLISH_SCOPE} ${version}`;
}

/**
 * Build the npm argv for a real publish. Hardcodes `--provenance`
 * and `--access public`. Always validates the tag against the
 * allow-list.
 *
 * Throws (rather than returns issues) so a caller can never
 * accidentally invoke spawn with an out-of-allowlist tag.
 *
 * Notice: the resulting array contains NO `--dry-run` token. The
 * runner has no other code path that prepends one.
 */
export function buildNpmPublishCommand({ tag } = {}) {
  if (!VALID_NPM_TAGS.includes(tag)) {
    throw new Error(
      `buildNpmPublishCommand: tag must be one of ${VALID_NPM_TAGS.join('|')} (got ${JSON.stringify(tag)}).`,
    );
  }
  return Object.freeze([
    'publish',
    '--provenance',
    '--access',
    'public',
    '--tag',
    tag,
  ]);
}

function makeIssue(code, message, recommendation) {
  return { level: 'error', code, message, recommendation: recommendation ?? null };
}

/**
 * Validate the parsed CLI flags / environment for a real publish.
 *
 * In `validateOnly` mode the workspace version + tag still get
 * checked, but the confirmation string and the auth token are
 * intentionally NOT required (the dry-run preflight job in CI runs in
 * a token-less environment).
 *
 * Returns `{ issues, expectedConfirm }` so the runner can echo the
 * expected confirmation in its error message.
 */
export function validatePublishInputs({ version, tag, confirm, env, validateOnly }, workspace) {
  const issues = [];
  const expectedConfirm = typeof version === 'string' ? expectedPublishConfirmation(version) : null;

  // 1. version
  if (typeof version !== 'string' || version.length === 0) {
    issues.push(
      makeIssue(
        'PUBLISH_INPUT_VERSION_REQUIRED',
        '--version is required.',
        'Pass --version X.Y.Z (must match every package.json version).',
      ),
    );
  } else if (parseSemver(version) === null) {
    issues.push(
      makeIssue(
        'PUBLISH_INPUT_VERSION_INVALID',
        `--version ${JSON.stringify(version)} is not strict X.Y.Z.`,
        'Use a strict semver like 0.1.0.',
      ),
    );
  } else if (workspace) {
    // Confirm every candidate's version matches the input.
    for (const c of workspace.candidates) {
      if (c.missing || !c.pkg) continue;
      const pkgVersion = c.pkg.parsed?.version;
      if (pkgVersion !== version) {
        issues.push(
          makeIssue(
            'PUBLISH_INPUT_VERSION_MISMATCH',
            `${EXPECTED_PACKAGE_NAMES[c.dir]} reports version ${JSON.stringify(pkgVersion)}, --version was ${JSON.stringify(version)}.`,
            'Run pnpm release:plan --bump <kind> --write to align the workspace, or pass the matching --version.',
          ),
        );
      }
    }
  }

  // 2. tag
  if (typeof tag !== 'string' || !VALID_NPM_TAGS.includes(tag)) {
    issues.push(
      makeIssue(
        'PUBLISH_INPUT_TAG_INVALID',
        `--tag must be one of ${VALID_NPM_TAGS.join('|')} (got ${JSON.stringify(tag)}).`,
        null,
      ),
    );
  }

  // 3. confirm + token (real-mode only)
  if (!validateOnly) {
    if (typeof confirm !== 'string' || confirm.length === 0) {
      issues.push(
        makeIssue(
          'PUBLISH_INPUT_CONFIRM_REQUIRED',
          '--confirm is required for a real publish.',
          expectedConfirm
            ? `Pass --confirm "${expectedConfirm}".`
            : 'Pass --confirm "publish @plccopilot <version>".',
        ),
      );
    } else if (expectedConfirm && confirm !== expectedConfirm) {
      issues.push(
        makeIssue(
          'PUBLISH_INPUT_CONFIRM_MISMATCH',
          '--confirm did not match the expected string.',
          `Expected exactly: ${expectedConfirm}`,
        ),
      );
    }
    const e = env ?? {};
    for (const name of PUBLISH_REQUIRED_ENV_VARS) {
      if (typeof e[name] !== 'string' || e[name].length === 0) {
        issues.push(
          makeIssue(
            'PUBLISH_ENV_VAR_MISSING',
            `environment variable ${name} is required for a real publish.`,
            'Run from the GitHub Actions `npm-publish` environment with the NPM_TOKEN secret in scope.',
          ),
        );
      }
    }
  }

  return { issues, expectedConfirm };
}

/**
 * The fixed publish order. Re-exported from release-plan-lib for
 * runners that don't want to import two modules.
 */
export const PUBLISH_ORDER = Object.freeze([...RELEASE_PUBLISH_ORDER]);
