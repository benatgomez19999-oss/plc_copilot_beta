// Sprint 68 — pure tests for the promote-latest helper lib + the
// promote-latest.yml workflow YAML. The real `npm dist-tag add` runs
// against the registry from the runner; the helpers + workflow YAML
// are unit-tested without the network.
//
// (Single-line comments — JSDoc blocks would close on `*/` inside an
// `@plccopilot/...` package path.)

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_PACKAGE_NAMES,
  RELEASE_PUBLISH_ORDER,
  loadReleaseWorkspace,
} from '../scripts/release-plan-lib.mjs';
import {
  PROMOTE_DEFAULT_REGISTRY,
  PROMOTE_PACKAGE_ORDER,
  PROMOTE_REQUIRED_ENV_VARS,
  PROMOTE_SCOPE,
  PROMOTE_SOURCE_TAG,
  PROMOTE_TARGET_TAG,
  assertNoPublishSurface,
  buildNpmDistTagAddArgs,
  buildNpmViewTagArgs,
  expectedPromoteConfirmation,
  isNpmNotFoundError,
  parseNpmJson,
  parsePromoteLatestArgs,
  validatePromoteInputs,
  validateTagVersion,
} from '../scripts/release-promote-latest-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github', 'workflows', 'promote-latest.yml');

// =============================================================================
// constants
// =============================================================================

describe('promote-latest constants', () => {
  it('source tag is `next`, target tag is `latest`', () => {
    expect(PROMOTE_SOURCE_TAG).toBe('next');
    expect(PROMOTE_TARGET_TAG).toBe('latest');
  });

  it('uses the @plccopilot scope', () => {
    expect(PROMOTE_SCOPE).toBe('@plccopilot');
  });

  it('requires NODE_AUTH_TOKEN as the auth env var', () => {
    expect(PROMOTE_REQUIRED_ENV_VARS).toContain('NODE_AUTH_TOKEN');
  });

  it('promote order matches the release publish order exactly', () => {
    expect([...PROMOTE_PACKAGE_ORDER]).toEqual([...RELEASE_PUBLISH_ORDER]);
  });

  it('default registry is registry.npmjs.org', () => {
    expect(PROMOTE_DEFAULT_REGISTRY).toBe('https://registry.npmjs.org');
  });

  it('expected confirmation has the canonical shape', () => {
    expect(expectedPromoteConfirmation('0.1.0')).toBe(
      'promote @plccopilot 0.1.0 to latest',
    );
  });
});

// =============================================================================
// parsePromoteLatestArgs
// =============================================================================

describe('parsePromoteLatestArgs', () => {
  it('returns null fields for empty argv', () => {
    const { options, errors } = parsePromoteLatestArgs([]);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({
      version: null,
      registry: null,
      confirm: '',
      validateOnly: false,
      json: false,
      help: false,
    });
  });

  it('parses --version, --registry, --confirm (space + equals)', () => {
    const { options, errors } = parsePromoteLatestArgs([
      '--version', '0.1.0',
      '--registry=https://registry.npmjs.org',
      '--confirm', 'promote @plccopilot 0.1.0 to latest',
    ]);
    expect(errors).toEqual([]);
    expect(options?.version).toBe('0.1.0');
    expect(options?.registry).toBe('https://registry.npmjs.org');
    expect(options?.confirm).toBe('promote @plccopilot 0.1.0 to latest');
  });

  it('parses --validate-only / --json / --help', () => {
    expect(parsePromoteLatestArgs(['--validate-only']).options?.validateOnly).toBe(true);
    expect(parsePromoteLatestArgs(['--json']).options?.json).toBe(true);
    expect(parsePromoteLatestArgs(['-h']).options?.help).toBe(true);
  });

  it('emits PROMOTE_ARG_MISSING_VALUE for --version with no value', () => {
    const { errors } = parsePromoteLatestArgs(['--version']);
    expect(errors.map((e) => e.code)).toContain('PROMOTE_ARG_MISSING_VALUE');
  });

  it('emits PROMOTE_ARG_UNKNOWN on unknown args', () => {
    const { errors } = parsePromoteLatestArgs(['--banana']);
    expect(errors.map((e) => e.code)).toContain('PROMOTE_ARG_UNKNOWN');
  });

  it('rejects --publish / --no-dry-run / --yes / -y at parse time', () => {
    for (const flag of ['--publish', '--no-dry-run', '--yes', '-y']) {
      const { errors } = parsePromoteLatestArgs([flag]);
      const codes = errors.map((e) => e.code);
      expect(codes).toContain('PROMOTE_ARG_UNKNOWN');
    }
  });

  it('rejects non-array argv', () => {
    const { errors } = parsePromoteLatestArgs('nope' as any);
    expect(errors.map((e) => e.code)).toContain('PROMOTE_ARG_INVALID');
  });
});

// =============================================================================
// validatePromoteInputs
// =============================================================================

describe('validatePromoteInputs (validate-only)', () => {
  it('passes when version + registry match the live workspace', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { issues } = validatePromoteInputs(
      { version: '0.1.0', validateOnly: true },
      ws,
    );
    expect(issues).toEqual([]);
  });

  it('infers --version from the single-version workspace', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { options, issues } = validatePromoteInputs(
      { validateOnly: true },
      ws,
    );
    expect(issues).toEqual([]);
    expect(options.version).toBe('0.1.0');
  });

  it('fails on version mismatch with all 6 candidates', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { issues } = validatePromoteInputs(
      { version: '9.9.9', validateOnly: true },
      ws,
    );
    const codes = issues.map((i) => i.code);
    expect(codes.filter((c) => c === 'PROMOTE_INPUT_VERSION_MISMATCH').length).toBe(6);
  });

  it('fails on invalid semver / invalid registry', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const codes1 = validatePromoteInputs(
      { version: 'oops', validateOnly: true },
      ws,
    ).issues.map((i) => i.code);
    expect(codes1).toContain('PROMOTE_INPUT_VERSION_INVALID');

    const codes2 = validatePromoteInputs(
      { version: '0.1.0', registry: 'ftp://x', validateOnly: true },
      ws,
    ).issues.map((i) => i.code);
    expect(codes2).toContain('PROMOTE_INPUT_REGISTRY_INVALID');
  });

  it('does NOT require confirm or token in validate-only mode', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { issues } = validatePromoteInputs(
      { version: '0.1.0', validateOnly: true, env: {} },
      ws,
    );
    expect(issues).toEqual([]);
  });

  it('does NOT clobber defaults with parser-emitted nulls', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { options, issues } = validatePromoteInputs(
      { version: '0.1.0', registry: null as any, validateOnly: true },
      ws,
    );
    expect(issues).toEqual([]);
    expect(options.registry).toBe(PROMOTE_DEFAULT_REGISTRY);
  });
});

describe('validatePromoteInputs (real mode)', () => {
  function realInputs(overrides: Partial<Parameters<typeof validatePromoteInputs>[0]> = {}) {
    return {
      version: '0.1.0',
      confirm: 'promote @plccopilot 0.1.0 to latest',
      env: { NODE_AUTH_TOKEN: 'fake-token-for-testing' },
      validateOnly: false,
      ...overrides,
    };
  }

  it('passes with version + confirm + token', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { issues } = validatePromoteInputs(realInputs(), ws);
    expect(issues).toEqual([]);
  });

  it('fails when confirm is missing or wrong', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    expect(
      validatePromoteInputs(realInputs({ confirm: '' }), ws).issues.map((i) => i.code),
    ).toContain('PROMOTE_INPUT_CONFIRM_REQUIRED');
    expect(
      validatePromoteInputs(realInputs({ confirm: 'PROMOTE @plccopilot 0.1.0 to latest' }), ws).issues.map(
        (i) => i.code,
      ),
    ).toContain('PROMOTE_INPUT_CONFIRM_MISMATCH');
  });

  it('fails when confirm has trailing whitespace', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const codes = validatePromoteInputs(
      realInputs({ confirm: 'promote @plccopilot 0.1.0 to latest ' }),
      ws,
    ).issues.map((i) => i.code);
    expect(codes).toContain('PROMOTE_INPUT_CONFIRM_MISMATCH');
  });

  it('fails when NODE_AUTH_TOKEN is missing or empty', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    expect(
      validatePromoteInputs(realInputs({ env: {} }), ws).issues.map((i) => i.code),
    ).toContain('PROMOTE_ENV_VAR_MISSING');
    expect(
      validatePromoteInputs(realInputs({ env: { NODE_AUTH_TOKEN: '' } }), ws).issues.map(
        (i) => i.code,
      ),
    ).toContain('PROMOTE_ENV_VAR_MISSING');
  });
});

// =============================================================================
// command builders
// =============================================================================

describe('buildNpmViewTagArgs', () => {
  const ok = {
    packageName: '@plccopilot/cli',
    tag: 'next' as const,
    registry: 'https://registry.npmjs.org',
  };

  it('emits the canonical view argv', () => {
    expect([...buildNpmViewTagArgs(ok)]).toEqual([
      'view',
      '@plccopilot/cli@next',
      'version',
      '--json',
      '--registry',
      'https://registry.npmjs.org',
    ]);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(buildNpmViewTagArgs(ok))).toBe(true);
  });

  it('rejects out-of-scope package, unknown tag, file:// registry', () => {
    expect(() => buildNpmViewTagArgs({ ...ok, packageName: 'left-pad' })).toThrow();
    expect(() => buildNpmViewTagArgs({ ...ok, tag: 'experimental' as any })).toThrow();
    expect(() => buildNpmViewTagArgs({ ...ok, registry: 'file:./x' })).toThrow();
  });

  it('never contains `publish`', () => {
    for (const tag of ['next', 'latest', 'beta'] as const) {
      const args = buildNpmViewTagArgs({ ...ok, tag });
      expect(args).not.toContain('publish');
      expect(args).not.toContain('--publish');
    }
  });
});

describe('buildNpmDistTagAddArgs', () => {
  const ok = {
    packageName: '@plccopilot/cli',
    version: '0.1.0',
    tag: 'latest' as const,
    registry: 'https://registry.npmjs.org',
  };

  it('emits the canonical dist-tag add argv', () => {
    expect([...buildNpmDistTagAddArgs(ok)]).toEqual([
      'dist-tag',
      'add',
      '@plccopilot/cli@0.1.0',
      'latest',
      '--registry',
      'https://registry.npmjs.org',
    ]);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(buildNpmDistTagAddArgs(ok))).toBe(true);
  });

  it('refuses any tag other than `latest`', () => {
    expect(() => buildNpmDistTagAddArgs({ ...ok, tag: 'next' as any })).toThrow(
      /tag must equal "latest"/,
    );
    expect(() => buildNpmDistTagAddArgs({ ...ok, tag: 'beta' as any })).toThrow();
  });

  it('rejects out-of-scope package + bad version + bad registry', () => {
    expect(() => buildNpmDistTagAddArgs({ ...ok, packageName: 'left-pad' })).toThrow();
    expect(() => buildNpmDistTagAddArgs({ ...ok, version: '0.1' })).toThrow();
    expect(() => buildNpmDistTagAddArgs({ ...ok, registry: 'file:./x' })).toThrow();
  });

  it('never contains `publish`', () => {
    const args = buildNpmDistTagAddArgs(ok);
    expect(args).not.toContain('publish');
    expect(args).not.toContain('--publish');
  });
});

// =============================================================================
// assertNoPublishSurface
// =============================================================================

describe('assertNoPublishSurface', () => {
  it('passes a clean dist-tag argv', () => {
    expect(
      assertNoPublishSurface([
        'dist-tag',
        'add',
        '@plccopilot/cli@0.1.0',
        'latest',
        '--registry',
        'https://registry.npmjs.org',
      ]),
    ).toBe(true);
  });

  it('throws on `publish` token', () => {
    expect(() => assertNoPublishSurface(['publish'])).toThrow(/publish/i);
  });

  it('throws on `--publish` and `--no-dry-run`', () => {
    expect(() => assertNoPublishSurface(['--publish'])).toThrow();
    expect(() => assertNoPublishSurface(['--no-dry-run'])).toThrow();
  });

  it('throws on non-array / non-string entries', () => {
    expect(() => assertNoPublishSurface('nope' as any)).toThrow();
    expect(() => assertNoPublishSurface([42 as any])).toThrow();
  });
});

// =============================================================================
// parseNpmJson
// =============================================================================

describe('parseNpmJson', () => {
  it('parses a JSON-quoted string (single-field view)', () => {
    expect(parseNpmJson('"0.1.0"')).toBe('0.1.0');
  });

  it('parses a JSON object', () => {
    expect((parseNpmJson('{"version":"0.1.0"}') as any)?.version).toBe('0.1.0');
  });

  it('tolerates leading npm warnings', () => {
    expect(parseNpmJson('npm warn old lockfile\n"0.1.0"')).toBe('0.1.0');
  });

  it('returns null on garbage', () => {
    expect(parseNpmJson('')).toBeNull();
    expect(parseNpmJson(undefined as any)).toBeNull();
    expect(parseNpmJson('not json at all')).toBeNull();
  });
});

// =============================================================================
// validateTagVersion
// =============================================================================

describe('validateTagVersion', () => {
  it('passes when value matches', () => {
    expect(
      validateTagVersion('0.1.0', {
        packageName: '@plccopilot/cli',
        version: '0.1.0',
        tag: 'next',
      }),
    ).toEqual([]);
  });

  it('emits PROMOTE_TAG_SOURCE_MISMATCH for `next`', () => {
    const codes = validateTagVersion('0.0.9', {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
      tag: 'next',
    }).map((i) => i.code);
    expect(codes).toContain('PROMOTE_TAG_SOURCE_MISMATCH');
  });

  it('emits PROMOTE_TAG_TARGET_MISMATCH for `latest`', () => {
    const codes = validateTagVersion('0.0.9', {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
      tag: 'latest',
    }).map((i) => i.code);
    expect(codes).toContain('PROMOTE_TAG_TARGET_MISMATCH');
  });

  it('treats non-string as mismatch', () => {
    const codes = validateTagVersion(undefined as any, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
      tag: 'next',
    }).map((i) => i.code);
    expect(codes).toContain('PROMOTE_TAG_SOURCE_MISMATCH');
  });
});

// =============================================================================
// isNpmNotFoundError
// =============================================================================

describe('isNpmNotFoundError', () => {
  it('detects E404 / 404 / no matching version', () => {
    expect(isNpmNotFoundError('npm error code E404', '')).toBe(true);
    expect(isNpmNotFoundError('', '404 Not Found')).toBe(true);
    expect(isNpmNotFoundError('no matching version found for ...', '')).toBe(true);
  });

  it('does NOT match unrelated errors', () => {
    expect(isNpmNotFoundError('ENOTFOUND registry.npmjs.org', '')).toBe(false);
    expect(isNpmNotFoundError('EACCES permission denied', '')).toBe(false);
  });
});

// =============================================================================
// promote-latest.yml workflow safety
// =============================================================================

describe('promote-latest.yml workflow safety', () => {
  const has = existsSync(WORKFLOW_PATH);
  const yaml = has ? readFileSync(WORKFLOW_PATH, 'utf-8') : '';

  (has ? it : it.skip)('is workflow_dispatch only (no push/schedule/pull_request)', () => {
    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).not.toMatch(/^on:[\s\S]*push:/m);
    expect(yaml).not.toMatch(/^on:[\s\S]*schedule:/m);
    expect(yaml).not.toMatch(/^on:[\s\S]*pull_request:/m);
  });

  (has ? it : it.skip)('declares version / registry / confirm inputs', () => {
    expect(yaml).toContain('version:');
    expect(yaml).toContain('registry:');
    expect(yaml).toContain('confirm:');
  });

  (has ? it : it.skip)('promote job uses the protected npm-publish environment', () => {
    expect(yaml).toMatch(/^[ \t]+environment:\s*npm-publish/m);
  });

  (has ? it : it.skip)('promote job exports NODE_AUTH_TOKEN from secrets.NPM_TOKEN', () => {
    expect(yaml).toContain('NODE_AUTH_TOKEN:');
    expect(yaml).toContain('secrets.NPM_TOKEN');
  });

  (has ? it : it.skip)('preflight runs validate-only AND release:npm-view --tag next', () => {
    expect(yaml).toContain('release:promote-latest --validate-only');
    expect(yaml).toMatch(/release:npm-view[\s\S]*?--tag\s+next/);
  });

  (has ? it : it.skip)('promote job invokes release:promote-latest with version + confirm', () => {
    expect(yaml).toContain('release:promote-latest');
    expect(yaml).toMatch(/--version\s+"\$\{\{\s*inputs\.version\s*\}\}"/);
    expect(yaml).toMatch(/--confirm\s+"\$\{\{\s*inputs\.confirm\s*\}\}"/);
  });

  (has ? it : it.skip)('does NOT shell out to `npm publish`', () => {
    const shellLines = yaml
      .split('\n')
      .map((l) => l.trimStart())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('name:'));
    expect(shellLines.filter((l) => /^npm\s+publish\b/.test(l))).toEqual([]);
  });

  (has ? it : it.skip)('does NOT shell out to `npm dist-tag` directly (only the runner may)', () => {
    const shellLines = yaml
      .split('\n')
      .map((l) => l.trimStart())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('name:'));
    expect(shellLines.filter((l) => /^npm\s+dist-tag\b/.test(l))).toEqual([]);
  });

  (has ? it : it.skip)('default version is 0.1.0 and default registry is npmjs.org', () => {
    expect(yaml).toMatch(/version:[\s\S]*?default:\s*'0\.1\.0'/);
    expect(yaml).toMatch(/registry:[\s\S]*?default:\s*'https:\/\/registry\.npmjs\.org'/);
  });
});

// =============================================================================
// promote-order coverage
// =============================================================================

describe('promote-order coverage', () => {
  it('includes every release candidate exactly once', () => {
    const expected = Object.values(EXPECTED_PACKAGE_NAMES).filter((name) =>
      RELEASE_PUBLISH_ORDER.includes(name),
    );
    expect([...PROMOTE_PACKAGE_ORDER].sort()).toEqual([...expected].sort());
    expect(PROMOTE_PACKAGE_ORDER.length).toBe(new Set(PROMOTE_PACKAGE_ORDER).size);
  });
});
