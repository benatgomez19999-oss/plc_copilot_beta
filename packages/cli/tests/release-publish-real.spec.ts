// Sprint 63 — pure tests for the real-publish helper lib + workflow file.
//
// (Single-line comments — a JSDoc with `*/` inside an `@plccopilot/...` path
// would close the block early. Same gotcha noted in earlier specs.)

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_PACKAGE_NAMES,
  RELEASE_PUBLISH_ORDER,
  loadReleaseWorkspace,
} from '../scripts/release-plan-lib.mjs';
import {
  PUBLISH_ORDER,
  PUBLISH_REQUIRED_ENV_VARS,
  PUBLISH_SCOPE,
  VALID_NPM_TAGS,
  buildNpmPublishCommand,
  expectedPublishConfirmation,
  validatePublishInputs,
} from '../scripts/release-publish-real-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github', 'workflows', 'publish.yml');

// =============================================================================
// constants
// =============================================================================

describe('publish constants', () => {
  it('exposes the canonical npm tag allow-list', () => {
    expect([...VALID_NPM_TAGS]).toEqual(['next', 'latest', 'beta']);
  });

  it('uses the @plccopilot scope for confirmations', () => {
    expect(PUBLISH_SCOPE).toBe('@plccopilot');
    expect(expectedPublishConfirmation('0.1.0')).toBe('publish @plccopilot 0.1.0');
  });

  it('requires NODE_AUTH_TOKEN as the auth env var', () => {
    expect(PUBLISH_REQUIRED_ENV_VARS).toContain('NODE_AUTH_TOKEN');
  });

  it('publish order matches the release plan publish order', () => {
    expect([...PUBLISH_ORDER]).toEqual([...RELEASE_PUBLISH_ORDER]);
  });
});

// =============================================================================
// buildNpmPublishCommand
// =============================================================================

describe('buildNpmPublishCommand', () => {
  it('always emits publish --provenance --access public --tag <tag>', () => {
    expect([...buildNpmPublishCommand({ tag: 'next' })]).toEqual([
      'publish',
      '--provenance',
      '--access',
      'public',
      '--tag',
      'next',
    ]);
  });

  it('never includes --dry-run', () => {
    for (const tag of VALID_NPM_TAGS) {
      const args = buildNpmPublishCommand({ tag });
      expect(args).not.toContain('--dry-run');
    }
  });

  it('returns a frozen array', () => {
    const args = buildNpmPublishCommand({ tag: 'latest' });
    expect(Object.isFrozen(args)).toBe(true);
  });

  it('rejects an unknown tag', () => {
    expect(() => buildNpmPublishCommand({ tag: 'experimental' as any })).toThrow(/tag must be/i);
  });

  it('rejects undefined tag', () => {
    expect(() => buildNpmPublishCommand({} as any)).toThrow(/tag must be/i);
  });

  it('emits next/latest/beta correctly', () => {
    expect(buildNpmPublishCommand({ tag: 'next' }).at(-1)).toBe('next');
    expect(buildNpmPublishCommand({ tag: 'latest' }).at(-1)).toBe('latest');
    expect(buildNpmPublishCommand({ tag: 'beta' }).at(-1)).toBe('beta');
  });
});

// =============================================================================
// validatePublishInputs
// =============================================================================

describe('validatePublishInputs (validate-only)', () => {
  it('passes when version + tag match the live workspace', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { issues } = validatePublishInputs(
      { version: '0.1.0', tag: 'next', validateOnly: true },
      ws,
    );
    expect(issues).toEqual([]);
  });

  it('fails on version mismatch with all 6 candidates', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { issues } = validatePublishInputs(
      { version: '9.9.9', tag: 'next', validateOnly: true },
      ws,
    );
    const codes = issues.map((i) => i.code);
    expect(codes.filter((c) => c === 'PUBLISH_INPUT_VERSION_MISMATCH').length).toBe(6);
  });

  it('fails on invalid tag', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const codes = validatePublishInputs(
      { version: '0.1.0', tag: 'rolling', validateOnly: true },
      ws,
    ).issues.map((i) => i.code);
    expect(codes).toContain('PUBLISH_INPUT_TAG_INVALID');
  });

  it('fails on invalid version', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const codes = validatePublishInputs(
      { version: 'oops', tag: 'next', validateOnly: true },
      ws,
    ).issues.map((i) => i.code);
    expect(codes).toContain('PUBLISH_INPUT_VERSION_INVALID');
  });

  it('fails on missing version', () => {
    const codes = validatePublishInputs(
      { version: undefined, tag: 'next', validateOnly: true },
      null,
    ).issues.map((i) => i.code);
    expect(codes).toContain('PUBLISH_INPUT_VERSION_REQUIRED');
  });

  it('does NOT require confirm or token in validate-only mode', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { issues } = validatePublishInputs(
      { version: '0.1.0', tag: 'next', validateOnly: true, env: {} },
      ws,
    );
    expect(issues).toEqual([]);
  });
});

describe('validatePublishInputs (real mode)', () => {
  function realInputs(overrides: Partial<Parameters<typeof validatePublishInputs>[0]> = {}) {
    return {
      version: '0.1.0',
      tag: 'next' as const,
      confirm: 'publish @plccopilot 0.1.0',
      env: { NODE_AUTH_TOKEN: 'fake-token-for-testing' },
      validateOnly: false,
      ...overrides,
    };
  }

  it('passes with version + tag + confirm + token', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { issues } = validatePublishInputs(realInputs(), ws);
    expect(issues).toEqual([]);
  });

  it('fails when confirm is missing', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const codes = validatePublishInputs(realInputs({ confirm: '' }), ws).issues.map((i) => i.code);
    expect(codes).toContain('PUBLISH_INPUT_CONFIRM_REQUIRED');
  });

  it('fails when confirm has the wrong scope', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const codes = validatePublishInputs(
      realInputs({ confirm: 'publish @other 0.1.0' }),
      ws,
    ).issues.map((i) => i.code);
    expect(codes).toContain('PUBLISH_INPUT_CONFIRM_MISMATCH');
  });

  it('fails when confirm has trailing whitespace', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const codes = validatePublishInputs(
      realInputs({ confirm: 'publish @plccopilot 0.1.0 ' }),
      ws,
    ).issues.map((i) => i.code);
    expect(codes).toContain('PUBLISH_INPUT_CONFIRM_MISMATCH');
  });

  it('fails when NODE_AUTH_TOKEN is missing', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const codes = validatePublishInputs(realInputs({ env: {} }), ws).issues.map((i) => i.code);
    expect(codes).toContain('PUBLISH_ENV_VAR_MISSING');
  });

  it('fails when NODE_AUTH_TOKEN is the empty string', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const codes = validatePublishInputs(
      realInputs({ env: { NODE_AUTH_TOKEN: '' } }),
      ws,
    ).issues.map((i) => i.code);
    expect(codes).toContain('PUBLISH_ENV_VAR_MISSING');
  });

  it('expectedConfirm is returned even when validation fails', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const result = validatePublishInputs(realInputs({ confirm: 'nope' }), ws);
    expect(result.expectedConfirm).toBe('publish @plccopilot 0.1.0');
  });
});

// =============================================================================
// Workflow YAML safety properties
// =============================================================================

describe('publish.yml workflow safety', () => {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf-8');

  it('is workflow_dispatch only (no push / schedule trigger)', () => {
    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).not.toMatch(/^on:[\s\S]*push:/m);
    expect(yaml).not.toMatch(/^on:[\s\S]*schedule:/m);
  });

  it('declares dry_run input with default true', () => {
    expect(yaml).toMatch(/dry_run:[\s\S]*?default:\s*true/);
  });

  it('declares the npm_tag input as a choice over the allow-list', () => {
    expect(yaml).toContain('npm_tag:');
    for (const tag of VALID_NPM_TAGS) {
      expect(yaml).toContain(`- ${tag}`);
    }
  });

  it('declares a confirm input', () => {
    expect(yaml).toContain('confirm:');
  });

  it('publish job uses the protected npm-publish environment', () => {
    expect(yaml).toContain('environment: npm-publish');
  });

  it('publish job grants id-token: write for npm provenance', () => {
    expect(yaml).toMatch(/permissions:[\s\S]*?id-token:\s*write/);
  });

  it('publish job is gated by inputs.dry_run == false', () => {
    // Accept either Boolean false or quoted false in YAML/expression.
    expect(yaml).toMatch(/inputs\.dry_run\s*==\s*false/);
  });

  it('publish job exports NODE_AUTH_TOKEN from the NPM_TOKEN secret', () => {
    expect(yaml).toContain('NODE_AUTH_TOKEN:');
    expect(yaml).toContain('secrets.NPM_TOKEN');
  });

  it('publish job calls release:publish-real with --version, --tag, --confirm', () => {
    expect(yaml).toContain('release:publish-real');
    expect(yaml).toContain('--version');
    expect(yaml).toContain('--tag');
    expect(yaml).toContain('--confirm');
  });

  it('has no shell line that runs `npm publish` directly', () => {
    // Only inspect lines that look like shell commands (i.e., not step
    // names and not YAML comments). The runner spawns npm publish from
    // Node via release:publish-real; the workflow itself must never
    // shell out to npm publish — that would bypass the runner's
    // safety net.
    const shellLines = yaml
      .split('\n')
      .map((line) => line.trimStart())
      .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('name:'));
    const offenders = shellLines.filter((line) => /^npm\s+publish\b/.test(line));
    expect(offenders).toEqual([]);
  });

  it('preflight job does NOT use the npm-publish environment', () => {
    // Quick structural check: the only `environment:` in the file should
    // be on the publish job.
    const occurrences = yaml.match(/^[ \t]+environment:\s*npm-publish/gm) ?? [];
    expect(occurrences.length).toBe(1);
  });
});

// =============================================================================
// Sanity: every release candidate is in the publish order
// =============================================================================

describe('publish order coverage', () => {
  it('PUBLISH_ORDER includes every release candidate name exactly once', () => {
    const expectedNames = Object.values(EXPECTED_PACKAGE_NAMES).sort();
    expect([...PUBLISH_ORDER].sort()).toEqual(expectedNames);
    expect(PUBLISH_ORDER.length).toBe(new Set(PUBLISH_ORDER).size);
  });
});
