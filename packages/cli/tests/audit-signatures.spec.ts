// Sprint 71 — pure tests for the audit-signatures helper lib + the
// verify-signatures.yml workflow safety contract. The actual `npm
// audit signatures` against a temp consumer project is tested by
// hand (or via the manual workflow); the lib + workflow YAML are
// unit-tested without the network.
//
// (Single-line comments — JSDoc blocks would close on `*/` inside an
// `@plccopilot/...` package path.)

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDIT_SIGNATURES_DEFAULT_PACKAGE,
  AUDIT_SIGNATURES_DEFAULT_REGISTRY,
  AUDIT_SIGNATURES_DEFAULTS,
  AUDIT_SIGNATURES_INSTALL_FLAGS,
  AUDIT_SIGNATURES_SCOPE,
  assertNoNpmMutationSurfaceAuditSignatures,
  buildAuditSignaturesReport,
  buildInstalledPackageSpec,
  buildNpmAuditSignaturesArgs,
  buildNpmInstallArgs,
  isNoSignaturesFound,
  isNpmAuditSignaturesUnsupported,
  isPackageNotFoundError,
  isSignatureFailure,
  parseAuditSignaturesArgs,
  parseAuditSignaturesJson,
  summarizeSpawnFailure,
  validateAuditSignaturesOptions,
} from '../scripts/audit-signatures-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github', 'workflows', 'verify-signatures.yml');

// =============================================================================
// constants
// =============================================================================

describe('audit-signatures constants', () => {
  it('default registry is npmjs', () => {
    expect(AUDIT_SIGNATURES_DEFAULT_REGISTRY).toBe('https://registry.npmjs.org');
  });

  it('default package is @plccopilot/cli (full graph)', () => {
    expect(AUDIT_SIGNATURES_DEFAULT_PACKAGE).toBe('@plccopilot/cli');
  });

  it('scope guard is @plccopilot/', () => {
    expect(AUDIT_SIGNATURES_SCOPE).toBe('@plccopilot/');
  });

  it('install flags include ignore-scripts / no-audit / no-fund', () => {
    expect([...AUDIT_SIGNATURES_INSTALL_FLAGS]).toEqual([
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
  });

  it('defaults bag exposes registry / packageName / installFlags', () => {
    expect(AUDIT_SIGNATURES_DEFAULTS.registry).toBe(AUDIT_SIGNATURES_DEFAULT_REGISTRY);
    expect(AUDIT_SIGNATURES_DEFAULTS.packageName).toBe(AUDIT_SIGNATURES_DEFAULT_PACKAGE);
    expect([...AUDIT_SIGNATURES_DEFAULTS.installFlags]).toEqual([...AUDIT_SIGNATURES_INSTALL_FLAGS]);
  });
});

// =============================================================================
// parseAuditSignaturesArgs
// =============================================================================

describe('parseAuditSignaturesArgs', () => {
  it('returns the option bag for empty argv', () => {
    const { options, errors } = parseAuditSignaturesArgs([]);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({
      version: null,
      registry: null,
      packageName: null,
      keep: false,
      json: false,
      help: false,
    });
  });

  it('parses --version (space + equals form)', () => {
    expect(
      parseAuditSignaturesArgs(['--version', '0.1.0']).options?.version,
    ).toBe('0.1.0');
    expect(parseAuditSignaturesArgs(['--version=0.1.0']).options?.version).toBe('0.1.0');
  });

  it('parses --registry, --package (space + equals form)', () => {
    const { options } = parseAuditSignaturesArgs([
      '--registry', 'https://r.example',
      '--package=@plccopilot/pir',
    ]);
    expect(options?.registry).toBe('https://r.example');
    expect(options?.packageName).toBe('@plccopilot/pir');
  });

  it('parses --json / --keep / --help', () => {
    expect(parseAuditSignaturesArgs(['--json']).options?.json).toBe(true);
    expect(parseAuditSignaturesArgs(['--keep']).options?.keep).toBe(true);
    expect(parseAuditSignaturesArgs(['-h']).options?.help).toBe(true);
  });

  it('emits AUDIT_SIGNATURES_FLAG_MISSING_VALUE for --version with no value', () => {
    const { errors } = parseAuditSignaturesArgs(['--version']);
    expect(errors.map((e) => e.code)).toContain('AUDIT_SIGNATURES_FLAG_MISSING_VALUE');
  });

  it('emits AUDIT_SIGNATURES_UNKNOWN_FLAG / AUDIT_SIGNATURES_ARG_INVALID', () => {
    expect(parseAuditSignaturesArgs(['--banana']).errors.map((e) => e.code)).toContain(
      'AUDIT_SIGNATURES_UNKNOWN_FLAG',
    );
    expect(parseAuditSignaturesArgs('nope' as any).errors.map((e) => e.code)).toContain(
      'AUDIT_SIGNATURES_ARG_INVALID',
    );
  });

  it('rejects every npm-mutation flag at parse time', () => {
    for (const flag of ['--publish', '--no-dry-run', '--dry-run', '--dist-tag', '--yes', '-y']) {
      const codes = parseAuditSignaturesArgs([flag]).errors.map((e) => e.code);
      expect(codes).toContain('AUDIT_SIGNATURES_UNKNOWN_FLAG');
    }
  });
});

// =============================================================================
// validateAuditSignaturesOptions
// =============================================================================

describe('validateAuditSignaturesOptions', () => {
  it('passes for clean options', () => {
    const { options, issues } = validateAuditSignaturesOptions({
      version: '0.1.0',
      registry: 'https://registry.npmjs.org',
      packageName: '@plccopilot/cli',
    });
    expect(issues).toEqual([]);
    expect(options.version).toBe('0.1.0');
    expect(options.registry).toBe('https://registry.npmjs.org');
    expect(options.packageName).toBe('@plccopilot/cli');
  });

  it('applies defaults for registry + package when not given', () => {
    const { options } = validateAuditSignaturesOptions({ version: '0.1.0' });
    expect(options.registry).toBe(AUDIT_SIGNATURES_DEFAULT_REGISTRY);
    expect(options.packageName).toBe(AUDIT_SIGNATURES_DEFAULT_PACKAGE);
  });

  it('does NOT clobber defaults with parser-emitted nulls', () => {
    const { options, issues } = validateAuditSignaturesOptions({
      version: '0.1.0',
      registry: null as any,
      packageName: null as any,
    });
    expect(issues).toEqual([]);
    expect(options.registry).toBe(AUDIT_SIGNATURES_DEFAULT_REGISTRY);
    expect(options.packageName).toBe(AUDIT_SIGNATURES_DEFAULT_PACKAGE);
  });

  it('infers --version from the workspace if not given', () => {
    const ws = {
      candidates: [
        { dir: 'cli', missing: false, pkg: { parsed: { version: '0.1.0' } } },
        { dir: 'pir', missing: false, pkg: { parsed: { version: '0.1.0' } } },
      ],
    } as any;
    const { options, issues } = validateAuditSignaturesOptions({}, ws);
    expect(issues).toEqual([]);
    expect(options.version).toBe('0.1.0');
  });

  it('emits AUDIT_SIGNATURES_VERSION_REQUIRED when missing', () => {
    const codes = validateAuditSignaturesOptions({}).issues.map((i) => i.code);
    expect(codes).toContain('AUDIT_SIGNATURES_VERSION_REQUIRED');
  });

  it('emits AUDIT_SIGNATURES_VERSION_INVALID for non-strict semver', () => {
    const codes = validateAuditSignaturesOptions({ version: '0.1' }).issues.map((i) => i.code);
    expect(codes).toContain('AUDIT_SIGNATURES_VERSION_INVALID');
  });

  it('emits AUDIT_SIGNATURES_REGISTRY_INVALID for non-http(s) registry', () => {
    const codes = validateAuditSignaturesOptions({
      version: '0.1.0',
      registry: 'ftp://x',
    }).issues.map((i) => i.code);
    expect(codes).toContain('AUDIT_SIGNATURES_REGISTRY_INVALID');
  });

  it('emits AUDIT_SIGNATURES_PACKAGE_INVALID for out-of-scope package', () => {
    expect(
      validateAuditSignaturesOptions({
        version: '0.1.0',
        packageName: 'left-pad',
      }).issues.map((i) => i.code),
    ).toContain('AUDIT_SIGNATURES_PACKAGE_INVALID');
    expect(
      validateAuditSignaturesOptions({
        version: '0.1.0',
        packageName: '@plccopilot/',
      }).issues.map((i) => i.code),
    ).toContain('AUDIT_SIGNATURES_PACKAGE_INVALID');
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
      '@plccopilot/cli@0.1.0',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry',
      'https://registry.npmjs.org',
    ]);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(buildNpmInstallArgs(ok))).toBe(true);
  });

  it('always includes --ignore-scripts / --no-audit / --no-fund', () => {
    const args = [...buildNpmInstallArgs(ok)];
    expect(args).toContain('--ignore-scripts');
    expect(args).toContain('--no-audit');
    expect(args).toContain('--no-fund');
  });

  it('rejects out-of-scope package, bad version, bad registry', () => {
    expect(() => buildNpmInstallArgs({ ...ok, packageName: 'left-pad' })).toThrow();
    expect(() => buildNpmInstallArgs({ ...ok, version: '0.1' })).toThrow();
    expect(() => buildNpmInstallArgs({ ...ok, registry: 'file:./x' })).toThrow();
  });

  it('never contains npm-mutation tokens', () => {
    const args = buildNpmInstallArgs(ok);
    for (const banned of ['publish', '--publish', 'dist-tag', '--no-dry-run']) {
      expect([...args]).not.toContain(banned);
    }
  });
});

// =============================================================================
// buildNpmAuditSignaturesArgs
// =============================================================================

describe('buildNpmAuditSignaturesArgs', () => {
  it('emits the canonical text-mode argv', () => {
    expect([...buildNpmAuditSignaturesArgs()]).toEqual(['audit', 'signatures']);
  });

  it('emits the --json variant', () => {
    expect([...buildNpmAuditSignaturesArgs({ json: true })]).toEqual([
      'audit',
      'signatures',
      '--json',
    ]);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(buildNpmAuditSignaturesArgs())).toBe(true);
    expect(Object.isFrozen(buildNpmAuditSignaturesArgs({ json: true }))).toBe(true);
  });

  it('never contains mutation tokens', () => {
    for (const variant of [buildNpmAuditSignaturesArgs(), buildNpmAuditSignaturesArgs({ json: true })]) {
      for (const banned of ['publish', '--publish', 'dist-tag', '--no-dry-run']) {
        expect([...variant]).not.toContain(banned);
      }
    }
  });
});

// =============================================================================
// buildInstalledPackageSpec
// =============================================================================

describe('buildInstalledPackageSpec', () => {
  it('returns name@version', () => {
    expect(
      buildInstalledPackageSpec({ packageName: '@plccopilot/cli', version: '0.1.0' }),
    ).toBe('@plccopilot/cli@0.1.0');
  });

  it('rejects bad inputs', () => {
    expect(() =>
      buildInstalledPackageSpec({ packageName: 'left-pad', version: '0.1.0' }),
    ).toThrow();
    expect(() =>
      buildInstalledPackageSpec({ packageName: '@plccopilot/cli', version: '0.1' }),
    ).toThrow();
  });
});

// =============================================================================
// assertNoNpmMutationSurfaceAuditSignatures
// =============================================================================

describe('assertNoNpmMutationSurfaceAuditSignatures', () => {
  it('passes a clean install argv', () => {
    expect(
      assertNoNpmMutationSurfaceAuditSignatures([
        'install',
        '@plccopilot/cli@0.1.0',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry',
        'https://registry.npmjs.org',
      ]),
    ).toBe(true);
  });

  it('passes a clean audit signatures argv', () => {
    expect(
      assertNoNpmMutationSurfaceAuditSignatures(['audit', 'signatures', '--json']),
    ).toBe(true);
  });

  it('throws on mutation tokens', () => {
    for (const t of ['publish', '--publish', '--no-dry-run', 'dist-tag']) {
      expect(() => assertNoNpmMutationSurfaceAuditSignatures([t])).toThrow(/mutation surface/);
    }
  });

  it('throws on non-array / non-string entries', () => {
    expect(() => assertNoNpmMutationSurfaceAuditSignatures('nope' as any)).toThrow();
    expect(() => assertNoNpmMutationSurfaceAuditSignatures([42 as any])).toThrow();
  });
});

// =============================================================================
// parseAuditSignaturesJson
// =============================================================================

describe('parseAuditSignaturesJson', () => {
  it('parses the canonical success shape', () => {
    expect(parseAuditSignaturesJson('{"invalid":[],"missing":[]}')).toEqual({
      invalid: [],
      missing: [],
    });
  });

  it('tolerates leading npm warn lines', () => {
    expect(
      parseAuditSignaturesJson(
        'npm warn old config\n{"invalid":[],"missing":[{"name":"x","version":"1"}]}',
      ),
    ).toEqual({ invalid: [], missing: [{ name: 'x', version: '1' }] });
  });

  it('returns null on garbage / empty', () => {
    expect(parseAuditSignaturesJson('')).toBeNull();
    expect(parseAuditSignaturesJson(undefined as any)).toBeNull();
    expect(parseAuditSignaturesJson('not json at all')).toBeNull();
  });
});

// =============================================================================
// failure detection
// =============================================================================

describe('isNpmAuditSignaturesUnsupported', () => {
  it('matches "unknown command: signatures"', () => {
    expect(isNpmAuditSignaturesUnsupported('unknown command: signatures', '')).toBe(true);
  });

  it('matches "this command requires npm"', () => {
    expect(isNpmAuditSignaturesUnsupported('', 'this command requires npm 9.5')).toBe(true);
  });

  it('does NOT match unrelated errors', () => {
    expect(isNpmAuditSignaturesUnsupported('ENOTFOUND registry', '')).toBe(false);
    expect(isNpmAuditSignaturesUnsupported('', '7 packages have verified signatures')).toBe(false);
  });
});

describe('isSignatureFailure', () => {
  it('matches "signatures do not match" / EINTEGRITY', () => {
    expect(isSignatureFailure('signatures do not match', '')).toBe(true);
    expect(isSignatureFailure('npm error code EINTEGRITY', '')).toBe(true);
    expect(isSignatureFailure('signature verification failed', '')).toBe(true);
  });

  it('does NOT match passing output', () => {
    expect(isSignatureFailure('', '7 packages have verified registry signatures')).toBe(false);
  });
});

describe('isNoSignaturesFound', () => {
  it('matches "no registry signatures" / "this registry does not support"', () => {
    expect(isNoSignaturesFound('no registry signatures available', '')).toBe(true);
    expect(isNoSignaturesFound('this registry does not support signatures', '')).toBe(true);
  });

  it('does NOT match passing output', () => {
    expect(isNoSignaturesFound('', '7 packages have verified registry signatures')).toBe(false);
  });
});

describe('isPackageNotFoundError', () => {
  it('matches E404 / "no matching version" / "is not in the npm registry"', () => {
    expect(isPackageNotFoundError('npm error code E404', '')).toBe(true);
    expect(isPackageNotFoundError('no matching version found for foo@9.9.9', '')).toBe(true);
    expect(isPackageNotFoundError('@x/y is not in the npm registry', '')).toBe(true);
  });

  it('does NOT match unrelated errors', () => {
    expect(isPackageNotFoundError('ENOTFOUND registry', '')).toBe(false);
  });
});

// =============================================================================
// summarizeSpawnFailure
// =============================================================================

describe('summarizeSpawnFailure', () => {
  it('returns label + status + truncated stdout/stderr', () => {
    const summary = summarizeSpawnFailure('install', {
      status: 1,
      stdout: 'a'.repeat(2000),
      stderr: 'b'.repeat(2000),
    });
    expect(typeof summary).toBe('object');
    expect((summary as any).label).toBe('install');
    expect((summary as any).status).toBe(1);
    expect((summary as any).stdout.length).toBeLessThan(2000);
    expect((summary as any).stdout).toMatch(/truncated/);
  });

  it('returns a string sentinel for null result', () => {
    expect(summarizeSpawnFailure('install', null)).toMatch(/no result/);
  });
});

// =============================================================================
// buildAuditSignaturesReport
// =============================================================================

describe('buildAuditSignaturesReport', () => {
  function passingInputs(overrides: any = {}) {
    return {
      version: '0.1.0',
      registry: 'https://registry.npmjs.org',
      packageName: '@plccopilot/cli',
      installResult: { status: 0, stdout: 'added 7 packages', stderr: '' },
      auditResult: { status: 0, stdout: '{"invalid":[],"missing":[]}', stderr: '' },
      auditJson: { invalid: [], missing: [] },
      installIssues: [],
      auditIssues: [],
      tempDir: '/tmp/x',
      ...overrides,
    };
  }

  it('marks ok=true when install + audit both pass and arrays are empty', () => {
    const r = buildAuditSignaturesReport(passingInputs());
    expect(r.ok).toBe(true);
    expect(r.installed).toBe(true);
    expect(r.audit_signatures.passed).toBe(true);
    expect(r.audit_signatures.invalid_count).toBe(0);
    expect(r.audit_signatures.missing_count).toBe(0);
  });

  it('marks ok=false on install failure', () => {
    const r = buildAuditSignaturesReport(
      passingInputs({
        installResult: { status: 1, stdout: '', stderr: 'E404' },
        installIssues: [
          {
            level: 'error',
            code: 'AUDIT_SIGNATURES_PACKAGE_NOT_FOUND',
            message: 'x',
            recommendation: null,
          },
        ],
        auditResult: null,
        auditJson: null,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.installed).toBe(false);
  });

  it('marks ok=false when audit signature failure detected', () => {
    const r = buildAuditSignaturesReport(
      passingInputs({
        auditResult: { status: 1, stdout: '', stderr: 'signatures do not match' },
        auditJson: { invalid: [{ name: 'x' }], missing: [] },
        auditIssues: [
          {
            level: 'error',
            code: 'AUDIT_SIGNATURES_SIGNATURE_FAILED',
            message: 'x',
            recommendation: null,
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit_signatures.passed).toBe(false);
    expect(r.audit_signatures.invalid_count).toBe(1);
  });

  it('marks ok=false when missing[] non-empty even with exit 0', () => {
    const r = buildAuditSignaturesReport(
      passingInputs({
        auditJson: { invalid: [], missing: [{ name: 'y' }] },
        auditIssues: [
          {
            level: 'error',
            code: 'AUDIT_SIGNATURES_NO_SIGNATURES',
            message: 'x',
            recommendation: null,
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit_signatures.missing_count).toBe(1);
  });

  it('truncates very long stdout/stderr summaries', () => {
    const big = 'x'.repeat(5000);
    const r = buildAuditSignaturesReport(
      passingInputs({
        auditResult: { status: 0, stdout: big, stderr: big },
      }),
    );
    expect(r.audit_signatures.stdout_summary?.length).toBeLessThan(5000);
    expect(r.audit_signatures.stderr_summary?.length).toBeLessThan(5000);
  });

  it('exposes the temp_dir + note so consumers can grep them', () => {
    const r = buildAuditSignaturesReport(passingInputs());
    expect(r.temp_dir).toBe('/tmp/x');
    expect(r.note.toLowerCase()).toContain('npm audit signatures');
    expect(r.note.toLowerCase()).toContain('not a custom sigstore');
  });

  it('treats unknown invalid/missing counts (no JSON parse) as null + still requires exit 0', () => {
    const r = buildAuditSignaturesReport(
      passingInputs({
        auditJson: null,
      }),
    );
    expect(r.audit_signatures.invalid_count).toBeNull();
    expect(r.audit_signatures.missing_count).toBeNull();
    // exit was 0, install ok, no error issues — counts unknown should not flip ok=false
    expect(r.ok).toBe(true);
  });
});

// =============================================================================
// verify-signatures.yml workflow safety
// =============================================================================

describe('verify-signatures.yml workflow safety', () => {
  const has = existsSync(WORKFLOW_PATH);
  const yaml = has ? readFileSync(WORKFLOW_PATH, 'utf-8') : '';

  (has ? it : it.skip)('is workflow_dispatch only (no push/schedule/pull_request)', () => {
    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).not.toMatch(/^on:[\s\S]*push:/m);
    expect(yaml).not.toMatch(/^on:[\s\S]*schedule:/m);
    expect(yaml).not.toMatch(/^on:[\s\S]*pull_request:/m);
  });

  (has ? it : it.skip)('declares version / registry / package inputs with defaults', () => {
    expect(yaml).toMatch(/version:[\s\S]*?default:\s*'0\.1\.0'/);
    expect(yaml).toMatch(/registry:[\s\S]*?default:\s*'https:\/\/registry\.npmjs\.org'/);
    expect(yaml).toMatch(/package:[\s\S]*?default:\s*'@plccopilot\/cli'/);
  });

  (has ? it : it.skip)('top-level + job permissions are read-only', () => {
    expect(yaml).toMatch(/^permissions:\s*\n[ \t]+contents:\s*read/m);
    const writeMatch = yaml.match(/^[ \t]+contents:\s*write/m);
    expect(writeMatch).toBeNull();
  });

  (has ? it : it.skip)('does NOT declare an environment / use protected secrets', () => {
    expect(yaml).not.toMatch(/^[ \t]+environment:\s*npm-publish/m);
  });

  (has ? it : it.skip)('does NOT reference NPM_TOKEN or NODE_AUTH_TOKEN in any executable line', () => {
    const liveLines = yaml
      .split('\n')
      .map((l) => l.replace(/\s+#.*$/, '').trimEnd())
      .filter((l) => l.length > 0 && !l.trimStart().startsWith('#'));
    const live = liveLines.join('\n');
    expect(live).not.toContain('NPM_TOKEN');
    expect(live).not.toContain('NODE_AUTH_TOKEN');
  });

  (has ? it : it.skip)('invokes pnpm release:audit-signatures with --json', () => {
    expect(yaml).toContain('release:audit-signatures');
    expect(yaml).toMatch(/release:audit-signatures[\s\S]*?--json/);
    expect(yaml).toMatch(/--version\s+"\$\{\{\s*inputs\.version\s*\}\}"/);
    expect(yaml).toMatch(/--registry\s+"\$\{\{\s*inputs\.registry\s*\}\}"/);
    expect(yaml).toMatch(/--package\s+"\$\{\{\s*inputs\.package\s*\}\}"/);
  });

  (has ? it : it.skip)('does NOT shell out to `npm publish` or `npm dist-tag`', () => {
    const shellLines = yaml
      .split('\n')
      .map((l) => l.trimStart())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('name:'));
    expect(shellLines.filter((l) => /^npm\s+publish\b/.test(l))).toEqual([]);
    expect(shellLines.filter((l) => /^npm\s+dist-tag\b/.test(l))).toEqual([]);
  });

  (has ? it : it.skip)('uses pnpm/action-setup + Node 24', () => {
    expect(yaml).toContain('uses: pnpm/action-setup@v3');
    expect(yaml).toMatch(/version:\s*9/);
    expect(yaml).toContain('node-version: 24');
  });
});
