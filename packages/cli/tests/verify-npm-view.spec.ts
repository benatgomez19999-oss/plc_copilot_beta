// Sprint 65 — pure tests for the npm-view verifier helper lib. The
// real `npm view` is exercised by the runner; this spec stays
// network-free.
//
// (Single-line comments — JSDoc blocks would close on `*/` inside an
// `@plccopilot/...` package path.)

import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_PACKAGE_NAMES,
  loadReleaseWorkspace,
} from '../scripts/release-plan-lib.mjs';
import {
  NPM_VIEW_DEFAULTS,
  buildNpmViewPackageArgs,
  buildNpmViewTagArgs,
  expectedForCandidate,
  isNpmViewNotFoundError,
  parseNpmViewArgs,
  parseNpmViewJson,
  validateNpmViewOptions,
  validateNpmViewPackageMetadata,
  validateNpmViewTagVersion,
} from '../scripts/verify-npm-view-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

// =============================================================================
// parseNpmViewArgs
// =============================================================================

describe('parseNpmViewArgs', () => {
  it('returns null fields for empty argv', () => {
    const { options, errors } = parseNpmViewArgs([]);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({
      version: null,
      registry: null,
      tag: null,
      json: false,
      help: false,
    });
  });

  it('parses --version, --registry, --tag, --json', () => {
    const { options, errors } = parseNpmViewArgs([
      '--version', '0.1.0',
      '--registry', 'https://registry.npmjs.org',
      '--tag', 'next',
      '--json',
    ]);
    expect(errors).toEqual([]);
    expect(options?.version).toBe('0.1.0');
    expect(options?.registry).toBe('https://registry.npmjs.org');
    expect(options?.tag).toBe('next');
    expect(options?.json).toBe(true);
  });

  it('parses equals-form flags', () => {
    const { options, errors } = parseNpmViewArgs(['--version=0.1.0', '--tag=next']);
    expect(errors).toEqual([]);
    expect(options?.version).toBe('0.1.0');
    expect(options?.tag).toBe('next');
  });

  it('emits NPM_VIEW_FLAG_MISSING_VALUE for --version with no value', () => {
    const { errors } = parseNpmViewArgs(['--version']);
    expect(errors.map((e) => e.code)).toContain('NPM_VIEW_FLAG_MISSING_VALUE');
  });

  it('emits NPM_VIEW_UNKNOWN_FLAG on unknown args', () => {
    const { errors } = parseNpmViewArgs(['--banana']);
    expect(errors.map((e) => e.code)).toContain('NPM_VIEW_UNKNOWN_FLAG');
  });

  it('rejects non-array argv', () => {
    const { errors } = parseNpmViewArgs('nope' as any);
    expect(errors.map((e) => e.code)).toContain('NPM_VIEW_ARGV_INVALID');
  });
});

// =============================================================================
// validateNpmViewOptions
// =============================================================================

describe('validateNpmViewOptions', () => {
  it('applies the registry default', () => {
    const { options, issues } = validateNpmViewOptions({ version: '0.1.0' }, null);
    expect(issues).toEqual([]);
    expect(options.registry).toBe(NPM_VIEW_DEFAULTS.registry);
  });

  it('infers --version from a single-version workspace', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { options, issues } = validateNpmViewOptions({}, ws);
    expect(issues).toEqual([]);
    expect(options.version).toBe('0.1.0');
  });

  it('emits NPM_VIEW_VERSION_REQUIRED when no version anywhere', () => {
    const { issues } = validateNpmViewOptions({}, null);
    expect(issues.map((i) => i.code)).toContain('NPM_VIEW_VERSION_REQUIRED');
  });

  it('emits NPM_VIEW_VERSION_INVALID for non-strict semver', () => {
    const { issues } = validateNpmViewOptions({ version: 'oops' }, null);
    expect(issues.map((i) => i.code)).toContain('NPM_VIEW_VERSION_INVALID');
  });

  it('emits NPM_VIEW_REGISTRY_INVALID for ftp:// or empty', () => {
    expect(
      validateNpmViewOptions({ version: '0.1.0', registry: '' }, null).issues.map((i) => i.code),
    ).toContain('NPM_VIEW_REGISTRY_INVALID');
    expect(
      validateNpmViewOptions(
        { version: '0.1.0', registry: 'ftp://example.com' },
        null,
      ).issues.map((i) => i.code),
    ).toContain('NPM_VIEW_REGISTRY_INVALID');
  });

  it('emits NPM_VIEW_TAG_INVALID for unknown tags', () => {
    const { issues } = validateNpmViewOptions(
      { version: '0.1.0', tag: 'experimental' as any },
      null,
    );
    expect(issues.map((i) => i.code)).toContain('NPM_VIEW_TAG_INVALID');
  });

  it('does NOT clobber defaults with parser-emitted nulls', () => {
    const { options, issues } = validateNpmViewOptions(
      { version: '0.1.0', registry: null as any, tag: null as any },
      null,
    );
    expect(issues).toEqual([]);
    expect(options.registry).toBe(NPM_VIEW_DEFAULTS.registry);
  });
});

// =============================================================================
// command builders
// =============================================================================

describe('buildNpmViewPackageArgs', () => {
  const ok = {
    packageName: '@plccopilot/cli',
    version: '0.1.0',
    registry: 'https://registry.npmjs.org',
  };

  it('emits the canonical argv', () => {
    expect([...buildNpmViewPackageArgs(ok)]).toEqual([
      'view',
      '@plccopilot/cli@0.1.0',
      '--json',
      '--registry',
      'https://registry.npmjs.org',
    ]);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(buildNpmViewPackageArgs(ok))).toBe(true);
  });

  it('rejects out-of-scope package, invalid version, file:// registry', () => {
    expect(() => buildNpmViewPackageArgs({ ...ok, packageName: 'left-pad' })).toThrow();
    expect(() => buildNpmViewPackageArgs({ ...ok, version: '0.1' })).toThrow();
    expect(() => buildNpmViewPackageArgs({ ...ok, registry: 'file:./x' })).toThrow();
  });
});

describe('buildNpmViewTagArgs', () => {
  const ok = {
    packageName: '@plccopilot/cli',
    tag: 'next',
    registry: 'https://registry.npmjs.org',
  };

  it('emits view <pkg>@<tag> version --json --registry', () => {
    expect([...buildNpmViewTagArgs(ok)]).toEqual([
      'view',
      '@plccopilot/cli@next',
      'version',
      '--json',
      '--registry',
      'https://registry.npmjs.org',
    ]);
  });

  it('rejects unknown tag', () => {
    expect(() => buildNpmViewTagArgs({ ...ok, tag: 'experimental' as any })).toThrow();
  });
});

// =============================================================================
// parseNpmViewJson
// =============================================================================

describe('parseNpmViewJson', () => {
  it('parses a JSON object', () => {
    const r = parseNpmViewJson('{"name":"@plccopilot/cli","version":"0.1.0"}');
    expect((r as any)?.name).toBe('@plccopilot/cli');
  });

  it('parses a JSON-quoted string (single-field view)', () => {
    expect(parseNpmViewJson('"0.1.0"')).toBe('0.1.0');
  });

  it('parses a JSON array', () => {
    expect(parseNpmViewJson('["a","b"]')).toEqual(['a', 'b']);
  });

  it('tolerates leading npm warnings', () => {
    const stdout =
      'npm warn old lockfile\n' +
      'npm notice anything\n' +
      '{"name":"@plccopilot/cli","version":"0.1.0"}';
    const r = parseNpmViewJson(stdout);
    expect((r as any)?.name).toBe('@plccopilot/cli');
  });

  it('returns null on empty / garbage input', () => {
    expect(parseNpmViewJson('')).toBeNull();
    expect(parseNpmViewJson('totally not json')).toBeNull();
    expect(parseNpmViewJson(undefined as any)).toBeNull();
  });
});

// =============================================================================
// validateNpmViewPackageMetadata
// =============================================================================

describe('validateNpmViewPackageMetadata', () => {
  const expected = { name: '@plccopilot/cli', version: '0.1.0' };
  const okMetadata = {
    name: '@plccopilot/cli',
    version: '0.1.0',
    dist: {
      tarball: 'https://registry.npmjs.org/@plccopilot/cli/-/cli-0.1.0.tgz',
      integrity: 'sha512-abcdef',
      shasum: '0123abc',
    },
  };

  it('passes a clean payload', () => {
    expect(validateNpmViewPackageMetadata(okMetadata, expected)).toEqual([]);
  });

  it('emits NPM_VIEW_NO_OBJECT for null / array', () => {
    expect(validateNpmViewPackageMetadata(null, expected).map((i) => i.code)).toContain(
      'NPM_VIEW_NO_OBJECT',
    );
    expect(validateNpmViewPackageMetadata([] as any, expected).map((i) => i.code)).toContain(
      'NPM_VIEW_NO_OBJECT',
    );
  });

  it('emits NPM_VIEW_NAME_MISMATCH', () => {
    const codes = validateNpmViewPackageMetadata(
      { ...okMetadata, name: '@bad/name' },
      expected,
    ).map((i) => i.code);
    expect(codes).toContain('NPM_VIEW_NAME_MISMATCH');
  });

  it('emits NPM_VIEW_VERSION_MISMATCH', () => {
    const codes = validateNpmViewPackageMetadata(
      { ...okMetadata, version: '0.0.9' },
      expected,
    ).map((i) => i.code);
    expect(codes).toContain('NPM_VIEW_VERSION_MISMATCH');
  });

  it('emits NPM_VIEW_DIST_MISSING when dist absent', () => {
    const codes = validateNpmViewPackageMetadata(
      { name: expected.name, version: expected.version },
      expected,
    ).map((i) => i.code);
    expect(codes).toContain('NPM_VIEW_DIST_MISSING');
  });

  it('emits NPM_VIEW_DIST_TARBALL_MISSING + INTEGRITY_MISSING', () => {
    const codes = validateNpmViewPackageMetadata(
      { name: expected.name, version: expected.version, dist: {} },
      expected,
    ).map((i) => i.code);
    expect(codes).toContain('NPM_VIEW_DIST_TARBALL_MISSING');
    expect(codes).toContain('NPM_VIEW_DIST_INTEGRITY_MISSING');
  });

  it('does NOT require dist.shasum', () => {
    const codes = validateNpmViewPackageMetadata(
      {
        ...okMetadata,
        dist: { tarball: okMetadata.dist.tarball, integrity: okMetadata.dist.integrity },
      },
      expected,
    ).map((i) => i.code);
    expect(codes).toEqual([]);
  });
});

// =============================================================================
// validateNpmViewTagVersion
// =============================================================================

describe('validateNpmViewTagVersion', () => {
  const expected = { name: '@plccopilot/cli', version: '0.1.0', tag: 'next' };

  it('passes when tag value matches', () => {
    expect(validateNpmViewTagVersion('0.1.0', expected)).toEqual([]);
  });

  it('emits NPM_VIEW_TAG_VERSION_MISMATCH when value differs', () => {
    const codes = validateNpmViewTagVersion('0.0.9', expected).map((i) => i.code);
    expect(codes).toContain('NPM_VIEW_TAG_VERSION_MISMATCH');
  });

  it('treats non-string value as mismatch', () => {
    const codes = validateNpmViewTagVersion(undefined as any, expected).map((i) => i.code);
    expect(codes).toContain('NPM_VIEW_TAG_VERSION_MISMATCH');
  });
});

// =============================================================================
// not-found detection
// =============================================================================

describe('isNpmViewNotFoundError', () => {
  it('detects npm error code E404', () => {
    expect(isNpmViewNotFoundError('npm error code E404\nnpm error 404 Not Found', '')).toBe(true);
  });

  it('detects "no matching version"', () => {
    expect(isNpmViewNotFoundError('npm error notarget no matching version found for ...', '')).toBe(true);
  });

  it('does NOT match unrelated errors', () => {
    expect(isNpmViewNotFoundError('ENOTFOUND registry.npmjs.org', '')).toBe(false);
    expect(isNpmViewNotFoundError('EACCES permission denied', '')).toBe(false);
  });
});

// =============================================================================
// expectedForCandidate
// =============================================================================

describe('expectedForCandidate', () => {
  it('returns the expected name for every release dir', () => {
    for (const dir of Object.keys(EXPECTED_PACKAGE_NAMES)) {
      expect(expectedForCandidate(dir, '0.1.0').name).toBe(
        EXPECTED_PACKAGE_NAMES[dir as keyof typeof EXPECTED_PACKAGE_NAMES],
      );
    }
  });

  it('throws on unknown release dir', () => {
    expect(() => expectedForCandidate('not-a-pkg', '0.1.0')).toThrow();
  });
});
