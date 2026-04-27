// Sprint 62 — pure helpers behind `pnpm release:publish-dry-run`.
//
// Hardcodes `--dry-run --json`. The runner has no flag, env var, or
// branch that can produce a non-dry-run command — verified by tests.
// `npm publish --dry-run --json` exits 0 with a single JSON object
// on stdout (warnings + notices land on stderr; we ignore those when
// the exit code is 0).

const REQUIRED_PUBLISH_ARGS = Object.freeze(['publish', '--dry-run', '--json']);

/**
 * Build the npm command line for a publish dry-run. Always returns
 * the same hardcoded `publish --dry-run --json` argv, regardless of
 * extra options (callers can add forwardArgs that are *appended* —
 * they cannot remove `--dry-run`).
 */
export function buildPublishDryRunCommand(forwardArgs = []) {
  if (!Array.isArray(forwardArgs)) {
    throw new TypeError('buildPublishDryRunCommand: forwardArgs must be an array');
  }
  for (const a of forwardArgs) {
    if (typeof a !== 'string') {
      throw new TypeError('buildPublishDryRunCommand: forward args must be strings');
    }
    if (a === '--no-dry-run' || a === '--publish' || a === '-y' || a === '--yes') {
      throw new Error(
        `buildPublishDryRunCommand: refusing forwarded arg ${JSON.stringify(a)} — release-publish-dry-run is dry-run only.`,
      );
    }
  }
  return {
    cmd: 'npm',
    args: [...REQUIRED_PUBLISH_ARGS, ...forwardArgs],
  };
}

export function isDryRunCommand(cmd) {
  if (!cmd || cmd.cmd !== 'npm') return false;
  const args = Array.isArray(cmd.args) ? cmd.args : [];
  return args.includes('--dry-run');
}

/**
 * Parse `npm publish --dry-run --json` stdout. Tolerates a leading
 * sequence of `npm warn`/`npm notice` lines (even though `--json`
 * normally routes those to stderr) by scanning for the first `{`.
 *
 * Returns the parsed object on success, or `null` if no JSON object
 * could be extracted. Caller decides how to handle nulls.
 */
export function parsePublishDryRunOutput(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    // Tolerate leading non-JSON garbage (warnings) by scanning to the
    // first `{` and JSON-parsing from there. This is best-effort.
    const i = stdout.indexOf('{');
    if (i < 0) return null;
    try {
      return JSON.parse(stdout.slice(i));
    } catch {
      return null;
    }
  }
}

/**
 * Validate one parsed dry-run object against the expected name +
 * version of a release candidate. Returns issue objects (empty on
 * success) — never throws.
 */
export function checkPublishDryRunResult(parsed, expected) {
  const issues = [];
  if (!parsed || typeof parsed !== 'object') {
    issues.push({
      level: 'error',
      code: 'PUBLISH_DRY_RUN_NO_JSON',
      package: expected.name,
      message: 'npm publish --dry-run --json did not emit a parseable JSON object on stdout.',
      recommendation: 'Re-run manually and inspect stdout/stderr.',
    });
    return issues;
  }
  if (typeof parsed.name !== 'string' || parsed.name !== expected.name) {
    issues.push({
      level: 'error',
      code: 'PUBLISH_DRY_RUN_NAME_MISMATCH',
      package: expected.name,
      message: `npm reports name=${JSON.stringify(parsed.name)} (expected ${expected.name})`,
      recommendation: null,
    });
  }
  if (typeof parsed.version !== 'string' || parsed.version !== expected.version) {
    issues.push({
      level: 'error',
      code: 'PUBLISH_DRY_RUN_VERSION_MISMATCH',
      package: expected.name,
      message: `npm reports version=${JSON.stringify(parsed.version)} (expected ${expected.version})`,
      recommendation: null,
    });
  }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    issues.push({
      level: 'error',
      code: 'PUBLISH_DRY_RUN_NO_FILES',
      package: expected.name,
      message: 'npm publish dry-run emitted an empty files[] — pack would publish nothing.',
      recommendation: 'Run pnpm release:pack-dry-run or pnpm release:check to investigate.',
    });
  }
  return issues;
}

/**
 * Validate one full spawn result (status, stdout, stderr, parsed)
 * end-to-end. The lib stays UI-free; the runner formats the output.
 */
export function checkPublishDryRunSpawn(result, expected) {
  const issues = [];
  if (result.error) {
    issues.push({
      level: 'error',
      code: 'PUBLISH_DRY_RUN_SPAWN_FAILED',
      package: expected.name,
      message: `spawning npm publish --dry-run failed: ${result.error.message ?? String(result.error)}`,
      recommendation: 'Check that npm is on PATH.',
    });
    return issues;
  }
  if (result.status !== 0) {
    issues.push({
      level: 'error',
      code: 'PUBLISH_DRY_RUN_NONZERO',
      package: expected.name,
      message: `npm publish --dry-run exited ${result.status}.`,
      recommendation:
        result.stderr && typeof result.stderr === 'string'
          ? `stderr: ${result.stderr.slice(0, 600)}`
          : null,
    });
    // Continue to also surface JSON-shape problems.
  }
  const parsed = parsePublishDryRunOutput(result.stdout);
  for (const i of checkPublishDryRunResult(parsed, expected)) issues.push(i);
  return issues;
}
