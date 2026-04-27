// Sprint 64 — pure tests for the registry-install smoke helper lib +
// the optional post-publish-verify workflow YAML. The real `npm install`
// is exercised by the runner; the lib is unit-tested without network.
//
// (Single-line comments because a JSDoc would close on `*/` inside an
// `@plccopilot/...` package path — same gotcha as earlier specs.)

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadReleaseWorkspace } from '../scripts/release-plan-lib.mjs';
import {
  REGISTRY_SMOKE_DEFAULTS,
  buildInstalledBinPath,
  buildNpmInstallArgs,
  isNpmNotFoundError,
  parseRegistrySmokeArgs,
  summarizeSpawnFailure,
  validateRegistrySmokeOptions,
} from '../scripts/smoke-registry-install-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github', 'workflows', 'post-publish-verify.yml');

// =============================================================================
// parseRegistrySmokeArgs
// =============================================================================

describe('parseRegistrySmokeArgs', () => {
  it('returns defaults-shaped options for empty argv', () => {
    const { options, errors } = parseRegistrySmokeArgs([]);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({
      version: null,
      registry: null,
      packageName: null,
      keep: false,
      help: false,
    });
  });

  it('parses --version / --registry / --package as separate args', () => {
    const { options, errors } = parseRegistrySmokeArgs([
      '--version', '0.1.0',
      '--registry', 'https://registry.npmjs.org',
      '--package', '@plccopilot/cli',
    ]);
    expect(errors).toEqual([]);
    expect(options?.version).toBe('0.1.0');
    expect(options?.registry).toBe('https://registry.npmjs.org');
    expect(options?.packageName).toBe('@plccopilot/cli');
  });

  it('parses --version=X.Y.Z equals form', () => {
    const { options, errors } = parseRegistrySmokeArgs(['--version=0.1.0']);
    expect(errors).toEqual([]);
    expect(options?.version).toBe('0.1.0');
  });

  it('parses --keep as a boolean flag', () => {
    const { options, errors } = parseRegistrySmokeArgs(['--keep']);
    expect(errors).toEqual([]);
    expect(options?.keep).toBe(true);
  });

  it('parses --help / -h as boolean flag', () => {
    expect(parseRegistrySmokeArgs(['--help']).options?.help).toBe(true);
    expect(parseRegistrySmokeArgs(['-h']).options?.help).toBe(true);
  });

  it('emits REGISTRY_SMOKE_FLAG_MISSING_VALUE for --version with no value', () => {
    const { errors } = parseRegistrySmokeArgs(['--version']);
    const codes = errors.map((e) => e.code);
    expect(codes).toContain('REGISTRY_SMOKE_FLAG_MISSING_VALUE');
  });

  it('emits REGISTRY_SMOKE_FLAG_MISSING_VALUE when next token is another flag', () => {
    const { errors } = parseRegistrySmokeArgs(['--version', '--keep']);
    const codes = errors.map((e) => e.code);
    expect(codes).toContain('REGISTRY_SMOKE_FLAG_MISSING_VALUE');
  });

  it('emits REGISTRY_SMOKE_UNKNOWN_FLAG on unknown args', () => {
    const { errors } = parseRegistrySmokeArgs(['--banana']);
    const codes = errors.map((e) => e.code);
    expect(codes).toContain('REGISTRY_SMOKE_UNKNOWN_FLAG');
  });

  it('rejects non-array argv', () => {
    const { errors } = parseRegistrySmokeArgs('not-an-array' as any);
    const codes = errors.map((e) => e.code);
    expect(codes).toContain('REGISTRY_SMOKE_ARGV_INVALID');
  });
});

// =============================================================================
// validateRegistrySmokeOptions
// =============================================================================

describe('validateRegistrySmokeOptions', () => {
  it('applies defaults for registry and packageName', () => {
    const { options, issues } = validateRegistrySmokeOptions(
      { version: '0.1.0' },
      null,
    );
    expect(issues).toEqual([]);
    expect(options.registry).toBe(REGISTRY_SMOKE_DEFAULTS.registry);
    expect(options.packageName).toBe(REGISTRY_SMOKE_DEFAULTS.packageName);
  });

  it('infers --version from a single-version workspace', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { options, issues } = validateRegistrySmokeOptions({}, ws);
    expect(issues).toEqual([]);
    expect(options.version).toBe('0.1.0');
  });

  it('keeps explicit --version even when workspace has its own', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { options, issues } = validateRegistrySmokeOptions(
      { version: '9.9.9' },
      ws,
    );
    expect(issues).toEqual([]);
    expect(options.version).toBe('9.9.9');
  });

  it('emits REGISTRY_SMOKE_VERSION_REQUIRED when no version anywhere', () => {
    const { issues } = validateRegistrySmokeOptions({}, null);
    expect(issues.map((i) => i.code)).toContain('REGISTRY_SMOKE_VERSION_REQUIRED');
  });

  it('emits REGISTRY_SMOKE_VERSION_INVALID for non-strict semver', () => {
    const { issues } = validateRegistrySmokeOptions({ version: 'v0.1' }, null);
    expect(issues.map((i) => i.code)).toContain('REGISTRY_SMOKE_VERSION_INVALID');
  });

  it('emits REGISTRY_SMOKE_REGISTRY_INVALID on empty registry', () => {
    const { issues } = validateRegistrySmokeOptions(
      { version: '0.1.0', registry: '' },
      null,
    );
    expect(issues.map((i) => i.code)).toContain('REGISTRY_SMOKE_REGISTRY_INVALID');
  });

  it('emits REGISTRY_SMOKE_REGISTRY_INVALID on non-http(s) registry', () => {
    const { issues } = validateRegistrySmokeOptions(
      { version: '0.1.0', registry: 'ftp://example.com' },
      null,
    );
    expect(issues.map((i) => i.code)).toContain('REGISTRY_SMOKE_REGISTRY_INVALID');
  });

  it('emits REGISTRY_SMOKE_PACKAGE_OUT_OF_SCOPE for non-@plccopilot package', () => {
    const { issues } = validateRegistrySmokeOptions(
      { version: '0.1.0', packageName: 'left-pad' },
      null,
    );
    expect(issues.map((i) => i.code)).toContain('REGISTRY_SMOKE_PACKAGE_OUT_OF_SCOPE');
  });

  it('does NOT clobber defaults with parser-emitted nulls', () => {
    // Regression for a bug caught during sprint 64: a raw bag with
    // explicit `null` for registry/packageName must still resolve to
    // the defaults.
    const { options, issues } = validateRegistrySmokeOptions(
      { version: '0.1.0', registry: null as any, packageName: null as any },
      null,
    );
    expect(issues).toEqual([]);
    expect(options.registry).toBe(REGISTRY_SMOKE_DEFAULTS.registry);
    expect(options.packageName).toBe(REGISTRY_SMOKE_DEFAULTS.packageName);
  });
});

// =============================================================================
// buildNpmInstallArgs
// =============================================================================

describe('buildNpmInstallArgs', () => {
  const ok = {
    packageName: '@plccopilot/cli',
    version: '0.1.0',
    registry: 'https://registry.npmjs.org',
  };

  it('emits the canonical install argv', () => {
    expect([...buildNpmInstallArgs(ok)]).toEqual([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry',
      'https://registry.npmjs.org',
      '@plccopilot/cli@0.1.0',
    ]);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(buildNpmInstallArgs(ok))).toBe(true);
  });

  it('rejects out-of-scope package names', () => {
    expect(() => buildNpmInstallArgs({ ...ok, packageName: 'left-pad' })).toThrow(
      /must start with @plccopilot/,
    );
  });

  it('rejects non-strict version', () => {
    expect(() => buildNpmInstallArgs({ ...ok, version: '0.1' })).toThrow(/strict X\.Y\.Z/);
  });

  it('rejects non-http(s) registry', () => {
    expect(() => buildNpmInstallArgs({ ...ok, registry: 'file:./local' })).toThrow(
      /http\(s\) URL/i,
    );
  });
});

// =============================================================================
// buildInstalledBinPath
// =============================================================================

describe('buildInstalledBinPath', () => {
  // `path.join` uses the host's separator, so the asserts below are
  // platform-agnostic — we check the relative tail rather than the
  // exact path.
  function tail(p: string): string {
    return p.replace(/\\/g, '/');
  }

  it('appends node_modules/.bin/plccopilot on POSIX-like platforms', () => {
    const got = tail(buildInstalledBinPath('/tmp/c', 'linux'));
    expect(got.endsWith('/tmp/c/node_modules/.bin/plccopilot')).toBe(true);
  });

  it('appends plccopilot.cmd on win32', () => {
    expect(tail(buildInstalledBinPath('C:/tmp/c', 'win32')).endsWith('plccopilot.cmd')).toBe(true);
  });

  it('rejects empty consumerDir', () => {
    expect(() => buildInstalledBinPath('', 'linux')).toThrow(/non-empty/);
  });
});

// =============================================================================
// isNpmNotFoundError
// =============================================================================

describe('isNpmNotFoundError', () => {
  it('detects E404 in stderr', () => {
    expect(isNpmNotFoundError('npm error code E404\nnpm error 404 Not Found', '')).toBe(true);
  });

  it('detects "not in this registry" prose', () => {
    expect(isNpmNotFoundError('@plccopilot/cli is not in this registry.', '')).toBe(true);
  });

  it('detects "no matching version" prose', () => {
    expect(isNpmNotFoundError('npm error notarget no matching version found for @plccopilot/cli@0.1.0', '')).toBe(true);
  });

  it('detects message in stdout when stderr is empty', () => {
    expect(isNpmNotFoundError('', '404 Not Found - GET https://registry.npmjs.org/...')).toBe(true);
  });

  it('does NOT match unrelated errors', () => {
    expect(isNpmNotFoundError('ENOTFOUND registry.npmjs.org', '')).toBe(false);
    expect(isNpmNotFoundError('EACCES permission denied', '')).toBe(false);
  });
});

// =============================================================================
// summarizeSpawnFailure
// =============================================================================

describe('summarizeSpawnFailure', () => {
  it('formats a non-zero exit', () => {
    const out = summarizeSpawnFailure('npm install', {
      status: 1,
      stdout: 'hello',
      stderr: 'boom',
    });
    expect(out).toContain('npm install failed');
    expect(out).toContain('status=1');
    expect(out).toContain('hello');
    expect(out).toContain('boom');
  });

  it('formats a spawn error', () => {
    const out = summarizeSpawnFailure('npm install', {
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawn ENOENT'),
    });
    expect(out).toContain('error=spawn ENOENT');
  });

  it('marks empty stdout/stderr as <empty>', () => {
    const out = summarizeSpawnFailure('lbl', { status: 1, stdout: '', stderr: '' });
    expect(out).toContain('<empty>');
  });

  it('truncates long stdout', () => {
    const out = summarizeSpawnFailure(
      'lbl',
      { status: 1, stdout: 'a'.repeat(2000), stderr: '' },
      50,
    );
    expect(out).toMatch(/truncated/);
  });
});

// =============================================================================
// post-publish-verify.yml workflow
// =============================================================================

describe('post-publish-verify.yml workflow', () => {
  // Skip the YAML-grep tests if the workflow has not been wired yet — the
  // sprint allowed this file to be optional. Each `it` re-checks
  // existence and skips cleanly if it's absent.
  const has = existsSync(WORKFLOW_PATH);

  (has ? it : it.skip)('is workflow_dispatch only (no push / schedule)', () => {
    const yaml = readFileSync(WORKFLOW_PATH, 'utf-8');
    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).not.toMatch(/^on:[\s\S]*push:/m);
    expect(yaml).not.toMatch(/^on:[\s\S]*schedule:/m);
  });

  (has ? it : it.skip)('declares version and registry inputs', () => {
    const yaml = readFileSync(WORKFLOW_PATH, 'utf-8');
    expect(yaml).toContain('version:');
    expect(yaml).toContain('registry:');
  });

  (has ? it : it.skip)('invokes the registry smoke runner', () => {
    const yaml = readFileSync(WORKFLOW_PATH, 'utf-8');
    expect(yaml).toContain('release:registry-smoke');
  });

  (has ? it : it.skip)('does NOT shell out to npm publish', () => {
    const yaml = readFileSync(WORKFLOW_PATH, 'utf-8');
    const shellLines = yaml
      .split('\n')
      .map((l) => l.trimStart())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('name:'));
    expect(shellLines.filter((l) => /^npm\s+publish\b/.test(l))).toEqual([]);
  });
});
