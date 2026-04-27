// Sprint 65 — pure tests for the provenance stub helper lib + the
// post-publish-verify.yml workflow assertions for the new steps.
//
// (Single-line comments — JSDoc blocks would close on `*/` inside an
// `@plccopilot/...` package path.)

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildProvenanceStubReport,
  checkPublishCommandProvenance,
  checkPublishWorkflowProvenance,
  parseProvenanceArgs,
} from '../scripts/verify-provenance-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const PUBLISH_WORKFLOW_PATH = resolve(REPO_ROOT, '.github', 'workflows', 'publish.yml');
const POST_PUBLISH_PATH = resolve(REPO_ROOT, '.github', 'workflows', 'post-publish-verify.yml');

const OK_WORKFLOW = `
name: Publish packages
permissions:
  contents: read
jobs:
  publish:
    permissions:
      contents: read
      id-token: write
    steps:
      - run: pnpm release:publish-real --version 0.1.0 --tag next --confirm "..."
        # invokes npm publish --provenance --access public --tag next
`;

// =============================================================================
// parseProvenanceArgs
// =============================================================================

describe('parseProvenanceArgs', () => {
  it('returns the option bag for empty argv', () => {
    const { options, errors } = parseProvenanceArgs([]);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({ version: null, json: false, help: false });
  });

  it('parses --version (space + equals form) and --json / --help', () => {
    expect(parseProvenanceArgs(['--version', '0.1.0', '--json']).options).toMatchObject({
      version: '0.1.0',
      json: true,
    });
    expect(parseProvenanceArgs(['--version=0.1.0']).options?.version).toBe('0.1.0');
    expect(parseProvenanceArgs(['-h']).options?.help).toBe(true);
  });

  it('emits PROVENANCE_FLAG_MISSING_VALUE for --version with no value', () => {
    const { errors } = parseProvenanceArgs(['--version']);
    expect(errors.map((e) => e.code)).toContain('PROVENANCE_FLAG_MISSING_VALUE');
  });

  it('emits PROVENANCE_UNKNOWN_FLAG / PROVENANCE_ARGV_INVALID', () => {
    expect(parseProvenanceArgs(['--banana']).errors.map((e) => e.code)).toContain(
      'PROVENANCE_UNKNOWN_FLAG',
    );
    expect(parseProvenanceArgs('nope' as any).errors.map((e) => e.code)).toContain(
      'PROVENANCE_ARGV_INVALID',
    );
  });
});

// =============================================================================
// checkPublishWorkflowProvenance
// =============================================================================

describe('checkPublishWorkflowProvenance', () => {
  it('passes the canonical workflow snippet', () => {
    expect(checkPublishWorkflowProvenance({ workflowText: OK_WORKFLOW })).toEqual([]);
  });

  it('passes the actual repo workflow', () => {
    const text = readFileSync(PUBLISH_WORKFLOW_PATH, 'utf-8');
    expect(checkPublishWorkflowProvenance({ workflowText: text })).toEqual([]);
  });

  it('emits PROVENANCE_WORKFLOW_NO_ID_TOKEN when missing', () => {
    const text = OK_WORKFLOW.replace(/id-token:\s*write/, 'id-token: read');
    const codes = checkPublishWorkflowProvenance({ workflowText: text }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_WORKFLOW_NO_ID_TOKEN');
  });

  it('emits PROVENANCE_WORKFLOW_NO_PROVENANCE_FLAG when missing', () => {
    const text = OK_WORKFLOW.replace('--provenance', '--ignore-this');
    const codes = checkPublishWorkflowProvenance({ workflowText: text }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_WORKFLOW_NO_PROVENANCE_FLAG');
  });

  it('emits PROVENANCE_WORKFLOW_MISSING for empty input', () => {
    const codes = checkPublishWorkflowProvenance({ workflowText: '' }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_WORKFLOW_MISSING');
  });
});

// =============================================================================
// checkPublishCommandProvenance
// =============================================================================

describe('checkPublishCommandProvenance', () => {
  it('passes when the live release-publish-real argv has --provenance for every tag', () => {
    expect(checkPublishCommandProvenance()).toEqual([]);
  });

  it('rejects an empty tag list', () => {
    const codes = checkPublishCommandProvenance({ tags: [] }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_COMMAND_NO_TAGS');
  });

  it('rejects an unknown tag with PROVENANCE_COMMAND_BUILDER_THREW', () => {
    const codes = checkPublishCommandProvenance({ tags: ['experimental'] }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_COMMAND_BUILDER_THREW');
  });
});

// =============================================================================
// buildProvenanceStubReport
// =============================================================================

describe('buildProvenanceStubReport', () => {
  it('marks ok=true when both lists are empty', () => {
    const r = buildProvenanceStubReport({ version: '0.1.0', workflowIssues: [], commandIssues: [] });
    expect(r.ok).toBe(true);
    expect(r.checks.workflow_id_token_write).toBe(true);
    expect(r.checks.workflow_provenance_flag).toBe(true);
    expect(r.checks.command_provenance_flag).toBe(true);
    expect(r.checks.command_no_dry_run).toBe(true);
  });

  it('flips a specific check to false when its issue is present', () => {
    const r = buildProvenanceStubReport({
      version: '0.1.0',
      workflowIssues: [
        {
          level: 'error',
          code: 'PROVENANCE_WORKFLOW_NO_ID_TOKEN',
          message: 'x',
          recommendation: null,
        },
      ],
      commandIssues: [],
    });
    expect(r.ok).toBe(false);
    expect(r.checks.workflow_id_token_write).toBe(false);
    // Other checks remain true.
    expect(r.checks.workflow_provenance_flag).toBe(true);
  });

  it('always carries the stub note', () => {
    const r = buildProvenanceStubReport({
      version: null,
      workflowIssues: [],
      commandIssues: [],
    });
    expect(r.note.toLowerCase()).toContain('stub');
  });
});

// =============================================================================
// post-publish-verify.yml — sprint 65 step assertions
// =============================================================================

describe('post-publish-verify.yml workflow (sprint 65)', () => {
  const has = existsSync(POST_PUBLISH_PATH);
  const yaml = has ? readFileSync(POST_PUBLISH_PATH, 'utf-8') : '';

  (has ? it : it.skip)('runs release:provenance before any registry call', () => {
    expect(yaml).toContain('release:provenance');
    const provIdx = yaml.indexOf('release:provenance');
    const npmViewIdx = yaml.indexOf('release:npm-view');
    const smokeIdx = yaml.indexOf('release:registry-smoke');
    expect(provIdx).toBeGreaterThan(-1);
    expect(npmViewIdx).toBeGreaterThan(provIdx);
    expect(smokeIdx).toBeGreaterThan(provIdx);
  });

  (has ? it : it.skip)('runs release:npm-view (with and without tag, gated by check_tag input)', () => {
    expect(yaml).toContain('release:npm-view');
    expect(yaml).toContain('check_tag');
    expect(yaml).toMatch(/inputs\.check_tag\s*==\s*true/);
    expect(yaml).toMatch(/inputs\.check_tag\s*==\s*false/);
  });

  (has ? it : it.skip)('runs release:registry-smoke', () => {
    expect(yaml).toContain('release:registry-smoke');
  });

  (has ? it : it.skip)('declares a tag input restricted to next|latest|beta', () => {
    expect(yaml).toContain('npm_tag:');
    for (const tag of ['next', 'latest', 'beta']) {
      expect(yaml).toContain(`- ${tag}`);
    }
  });

  (has ? it : it.skip)('does NOT shell out to `npm publish`', () => {
    const shellLines = yaml
      .split('\n')
      .map((l) => l.trimStart())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('name:'));
    expect(shellLines.filter((l) => /^npm\s+publish\b/.test(l))).toEqual([]);
  });
});
