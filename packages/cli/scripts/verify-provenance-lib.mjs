// Sprint 65 — pure helpers behind `pnpm release:provenance`.
//
// Sprint 65 ships a *stub* — it does not pull attestation bundles from
// the npm registry. Instead it does the local-only verification that
// the publish path is *configured* to mint provenance:
//
//   1. The publish workflow (`.github/workflows/publish.yml`) grants
//      the publish job `id-token: write` (required by npm to obtain
//      an OIDC token for signing the attestation), AND
//   2. The publish argv built by `release-publish-real-lib.mjs`
//      contains `--provenance`.
//
// Deep attestation verification (downloading the npm provenance
// bundle, checking the certificate chain against Sigstore, etc.) is
// reserved for a future sprint.

import {
  buildNpmPublishCommand,
  VALID_NPM_TAGS,
} from './release-publish-real-lib.mjs';

function makeIssue(code, message, recommendation) {
  return {
    level: 'error',
    code,
    message,
    recommendation: recommendation ?? null,
  };
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

export function parseProvenanceArgs(argv) {
  if (!Array.isArray(argv)) {
    return {
      options: null,
      errors: [makeIssue('PROVENANCE_ARGV_INVALID', 'argv must be an array.')],
    };
  }
  const options = { version: null, json: false, help: false };
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') {
      errors.push(makeIssue('PROVENANCE_ARG_INVALID', 'arguments must be strings.'));
      continue;
    }
    if (a === '--help' || a === '-h') options.help = true;
    else if (a === '--json') options.json = true;
    else if (a === '--version') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        errors.push(makeIssue('PROVENANCE_FLAG_MISSING_VALUE', '--version requires a value.'));
      } else {
        options.version = next;
        i++;
      }
    } else if (a.startsWith('--version=')) {
      options.version = a.slice('--version='.length);
    } else {
      errors.push(makeIssue('PROVENANCE_UNKNOWN_FLAG', `unknown argument: ${JSON.stringify(a)}`));
    }
  }
  return { options, errors };
}

// ---------------------------------------------------------------------------
// workflow YAML check
// ---------------------------------------------------------------------------

/**
 * Inspect the publish workflow YAML and return issues if either the
 * `id-token: write` permission or any reference to `--provenance` is
 * missing. The check is regex-only — no YAML parser, no network.
 */
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

// ---------------------------------------------------------------------------
// command argv check
// ---------------------------------------------------------------------------

/**
 * Verify that the `release:publish-real` command builder still emits
 * `--provenance` for every supported tag. If a future refactor drops
 * the flag, the stub will catch it before any real publish runs.
 */
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

// ---------------------------------------------------------------------------
// report builder
// ---------------------------------------------------------------------------

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
