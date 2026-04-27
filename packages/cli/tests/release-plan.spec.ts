// Sprint 61 — pure tests for the release-plan library.
//
// Same pattern as publish-audit.spec.ts: import the .mjs lib via
// Vitest's TS transformer, exercise pure helpers + synthetic temp
// workspaces, and run one live-repo integration to catch regressions
// against the actual packages/<name>/package.json files. (Single-line
// comments — a JSDoc here would end early because `*/` inside the
// phrase `packages/*/package.json` would close the block comment.)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_PACKAGE_NAMES,
  ISSUE_CODES,
  RELEASE_PACKAGE_DIRS,
  RELEASE_PUBLISH_ORDER,
  applyReleasePlan,
  buildJsonPlan,
  buildReleasePlan,
  bumpVersion,
  checkPackManifest,
  checkReleaseState,
  compareSemver,
  formatSemver,
  loadReleaseWorkspace,
  parseSemver,
  renderMarkdownPlan,
} from '../scripts/release-plan-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'plccli-release-'));
}

const NPMRC_OK = 'link-workspace-packages=true\n';

function writePkg(dir: string, json: object): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json, null, 2) + '\n', 'utf-8');
}

function basePkg(dir: string, version = '0.1.0', overrides: any = {}): any {
  return {
    name: EXPECTED_PACKAGE_NAMES[dir as keyof typeof EXPECTED_PACKAGE_NAMES],
    version,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    },
    files: ['dist'],
    ...overrides,
  };
}

function writeCleanWorkspace(repo: string, version = '0.1.0'): void {
  writeFileSync(join(repo, '.npmrc'), NPMRC_OK, 'utf-8');
  mkdirSync(join(repo, 'packages'), { recursive: true });
  writePkg(join(repo, 'packages', 'pir'), basePkg('pir', version));
  writePkg(
    join(repo, 'packages', 'codegen-core'),
    basePkg('codegen-core', version, {
      dependencies: { '@plccopilot/pir': version },
    }),
  );
  writePkg(
    join(repo, 'packages', 'codegen-codesys'),
    basePkg('codegen-codesys', version, {
      dependencies: {
        '@plccopilot/codegen-core': version,
        '@plccopilot/pir': version,
      },
    }),
  );
  writePkg(
    join(repo, 'packages', 'codegen-rockwell'),
    basePkg('codegen-rockwell', version, {
      dependencies: {
        '@plccopilot/codegen-core': version,
        '@plccopilot/pir': version,
      },
    }),
  );
  writePkg(
    join(repo, 'packages', 'codegen-siemens'),
    basePkg('codegen-siemens', version, {
      dependencies: {
        '@plccopilot/codegen-codesys': version,
        '@plccopilot/codegen-core': version,
        '@plccopilot/codegen-rockwell': version,
        '@plccopilot/pir': version,
      },
    }),
  );
  writePkg(
    join(repo, 'packages', 'cli'),
    basePkg('cli', version, {
      bin: { plccopilot: './dist/index.js' },
      files: ['dist', 'schemas'],
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './schemas/cli-result.schema.json': './schemas/cli-result.schema.json',
        './schemas/serialized-compiler-error.schema.json':
          './schemas/serialized-compiler-error.schema.json',
        './schemas/generate-summary.schema.json': './schemas/generate-summary.schema.json',
        './schemas/web-zip-summary.schema.json': './schemas/web-zip-summary.schema.json',
      },
      dependencies: {
        '@plccopilot/codegen-codesys': version,
        '@plccopilot/codegen-core': version,
        '@plccopilot/codegen-rockwell': version,
        '@plccopilot/codegen-siemens': version,
        '@plccopilot/pir': version,
      },
    }),
  );
}

// =============================================================================
// semver helpers
// =============================================================================

describe('parseSemver / formatSemver / bumpVersion / compareSemver', () => {
  it('parses strict X.Y.Z', () => {
    expect(parseSemver('0.1.0')).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('rejects non-strict versions', () => {
    expect(parseSemver('0.1')).toBeNull();
    expect(parseSemver('v0.1.0')).toBeNull();
    expect(parseSemver('0.1.0-alpha')).toBeNull();
    expect(parseSemver('0.1.0+build')).toBeNull();
    expect(parseSemver('')).toBeNull();
    expect(parseSemver(undefined as any)).toBeNull();
  });

  it('formatSemver round-trips', () => {
    expect(formatSemver({ major: 1, minor: 2, patch: 3 })).toBe('1.2.3');
  });

  it('bumps patch / minor / major', () => {
    expect(bumpVersion('0.1.0', 'patch')).toBe('0.1.1');
    expect(bumpVersion('0.1.0', 'minor')).toBe('0.2.0');
    expect(bumpVersion('0.1.0', 'major')).toBe('1.0.0');
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
  });

  it('bumpVersion throws on garbage input', () => {
    expect(() => bumpVersion('not-semver', 'patch')).toThrow();
    expect(() => bumpVersion('0.1.0', 'huge' as any)).toThrow();
  });

  it('compareSemver orders correctly', () => {
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0);
    expect(compareSemver('0.1.0', '0.1.1')).toBe(-1);
    expect(compareSemver('0.2.0', '0.1.5')).toBe(1);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
  });
});

// =============================================================================
// loadReleaseWorkspace + checkReleaseState
// =============================================================================

describe('loadReleaseWorkspace + checkReleaseState', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = tmpRoot();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('loads all six candidates in publish order from a clean workspace', () => {
    writeCleanWorkspace(tmp);
    const ws = loadReleaseWorkspace(tmp);
    expect(ws.candidates.map((c: any) => c.dir)).toEqual([...RELEASE_PACKAGE_DIRS]);
    expect(ws.candidates.every((c: any) => !c.missing && c.pkg)).toBe(true);
  });

  it('flags a missing package directory', () => {
    writeCleanWorkspace(tmp);
    rmSync(join(tmp, 'packages', 'codegen-rockwell'), { recursive: true, force: true });
    const ws = loadReleaseWorkspace(tmp);
    const { issues } = checkReleaseState(ws);
    const codes = issues.map((i: any) => i.code);
    expect(codes).toContain(ISSUE_CODES.PACKAGE_DIR_MISSING);
  });

  it('passes with no issues on a clean workspace', () => {
    writeCleanWorkspace(tmp);
    const { issues, sharedVersion } = checkReleaseState(loadReleaseWorkspace(tmp));
    expect(issues).toEqual([]);
    expect(sharedVersion).toBe('0.1.0');
  });

  it('flags PACKAGE_NAME_MISMATCH', () => {
    writeCleanWorkspace(tmp);
    writePkg(join(tmp, 'packages', 'pir'), basePkg('pir', '0.1.0', { name: '@bad/name' }));
    const codes = checkReleaseState(loadReleaseWorkspace(tmp)).issues.map((i: any) => i.code);
    expect(codes).toContain(ISSUE_CODES.PACKAGE_NAME_MISMATCH);
  });

  it('flags PACKAGE_PRIVATE', () => {
    writeCleanWorkspace(tmp);
    writePkg(join(tmp, 'packages', 'cli'), basePkg('cli', '0.1.0', { private: true }));
    const codes = checkReleaseState(loadReleaseWorkspace(tmp)).issues.map((i: any) => i.code);
    expect(codes).toContain(ISSUE_CODES.PACKAGE_PRIVATE);
  });

  it('flags VERSION_INVALID', () => {
    writeCleanWorkspace(tmp);
    writePkg(join(tmp, 'packages', 'pir'), basePkg('pir', '0.1' as any));
    const codes = checkReleaseState(loadReleaseWorkspace(tmp)).issues.map((i: any) => i.code);
    expect(codes).toContain(ISSUE_CODES.VERSION_INVALID);
  });

  it('flags VERSION_MISMATCH when candidates disagree', () => {
    writeCleanWorkspace(tmp);
    writePkg(join(tmp, 'packages', 'cli'), basePkg('cli', '0.2.0'));
    const { issues, sharedVersion } = checkReleaseState(loadReleaseWorkspace(tmp));
    const codes = issues.map((i: any) => i.code);
    expect(codes).toContain(ISSUE_CODES.VERSION_MISMATCH);
    expect(sharedVersion).toBeNull();
  });

  it('flags DEP_WORKSPACE_PROTOCOL', () => {
    writeCleanWorkspace(tmp);
    writePkg(
      join(tmp, 'packages', 'codegen-core'),
      basePkg('codegen-core', '0.1.0', {
        dependencies: { '@plccopilot/pir': 'workspace:*' },
      }),
    );
    const codes = checkReleaseState(loadReleaseWorkspace(tmp)).issues.map((i: any) => i.code);
    expect(codes).toContain(ISSUE_CODES.DEP_WORKSPACE_PROTOCOL);
  });

  it('flags DEP_RANGE_MISMATCH', () => {
    writeCleanWorkspace(tmp);
    writePkg(
      join(tmp, 'packages', 'codegen-core'),
      basePkg('codegen-core', '0.1.0', {
        dependencies: { '@plccopilot/pir': '0.0.9' },
      }),
    );
    const codes = checkReleaseState(loadReleaseWorkspace(tmp)).issues.map((i: any) => i.code);
    expect(codes).toContain(ISSUE_CODES.DEP_RANGE_MISMATCH);
  });

  it('flags DEP_RANGE_INVALID for non-strict semver dep ranges', () => {
    writeCleanWorkspace(tmp);
    writePkg(
      join(tmp, 'packages', 'codegen-core'),
      basePkg('codegen-core', '0.1.0', {
        dependencies: { '@plccopilot/pir': '^0.1.0' },
      }),
    );
    const codes = checkReleaseState(loadReleaseWorkspace(tmp)).issues.map((i: any) => i.code);
    expect(codes).toContain(ISSUE_CODES.DEP_RANGE_INVALID);
  });

  it('flags MAIN_NOT_DIST / TYPES_NOT_DIST / EXPORTS_*_NOT_DIST', () => {
    writeCleanWorkspace(tmp);
    writePkg(
      join(tmp, 'packages', 'pir'),
      basePkg('pir', '0.1.0', {
        main: './src/index.ts',
        types: './src/index.ts',
        exports: { '.': './src/index.ts' },
      }),
    );
    const codes = checkReleaseState(loadReleaseWorkspace(tmp)).issues.map((i: any) => i.code);
    expect(codes).toContain(ISSUE_CODES.MAIN_NOT_DIST);
    expect(codes).toContain(ISSUE_CODES.TYPES_NOT_DIST);
    expect(codes).toContain(ISSUE_CODES.EXPORTS_DEFAULT_NOT_DIST);
    expect(codes).toContain(ISSUE_CODES.EXPORTS_TYPES_NOT_DIST);
  });

  it('flags FILES_MISSING_DIST', () => {
    writeCleanWorkspace(tmp);
    writePkg(join(tmp, 'packages', 'pir'), basePkg('pir', '0.1.0', { files: [] }));
    const codes = checkReleaseState(loadReleaseWorkspace(tmp)).issues.map((i: any) => i.code);
    expect(codes).toContain(ISSUE_CODES.FILES_MISSING_DIST);
  });

  it('flags CLI_BIN_MISSING + CLI_SCHEMA_EXPORT_MISSING + FILES_MISSING_SCHEMAS', () => {
    writeCleanWorkspace(tmp);
    writePkg(join(tmp, 'packages', 'cli'), basePkg('cli', '0.1.0', { files: ['dist'] }));
    const codes = checkReleaseState(loadReleaseWorkspace(tmp)).issues.map((i: any) => i.code);
    expect(codes).toContain(ISSUE_CODES.CLI_BIN_MISSING);
    expect(codes).toContain(ISSUE_CODES.CLI_SCHEMA_EXPORT_MISSING);
    expect(codes).toContain(ISSUE_CODES.FILES_MISSING_SCHEMAS);
  });

  it('flags NPMRC_LINK_MISSING', () => {
    writeCleanWorkspace(tmp);
    writeFileSync(join(tmp, '.npmrc'), '# empty\n', 'utf-8');
    const codes = checkReleaseState(loadReleaseWorkspace(tmp)).issues.map((i: any) => i.code);
    expect(codes).toContain(ISSUE_CODES.NPMRC_LINK_MISSING);
  });
});

// =============================================================================
// buildReleasePlan
// =============================================================================

describe('buildReleasePlan', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = tmpRoot();
    writeCleanWorkspace(tmp);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('produces an ok patch plan with target_version 0.1.1', () => {
    const plan = buildReleasePlan(loadReleaseWorkspace(tmp), {
      kind: 'bump',
      bump: 'patch',
    });
    expect(plan.ok).toBe(true);
    expect(plan.current_version).toBe('0.1.0');
    expect(plan.target_version).toBe('0.1.1');
    expect(plan.package_count).toBe(6);
    expect(plan.publish_order).toEqual([...RELEASE_PUBLISH_ORDER]);
  });

  it('lists every internal dep update for a patch plan', () => {
    const plan = buildReleasePlan(loadReleaseWorkspace(tmp), {
      kind: 'bump',
      bump: 'minor',
    });
    expect(plan.target_version).toBe('0.2.0');
    // 14 internal runtime ranges total across the 6 candidates.
    expect(plan.dependency_updates.length).toBe(14);
    expect(plan.dependency_updates.every((u: any) => u.from === '0.1.0' && u.to === '0.2.0')).toBe(
      true,
    );
  });

  it('rejects an exact target that does not strictly increment', () => {
    const plan = buildReleasePlan(loadReleaseWorkspace(tmp), {
      kind: 'exact',
      version: '0.1.0',
    });
    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i: any) => i.code)).toContain(ISSUE_CODES.TARGET_NOT_INCREMENT);
  });

  it('rejects an exact target that is not strict semver', () => {
    const plan = buildReleasePlan(loadReleaseWorkspace(tmp), {
      kind: 'exact',
      version: 'oops',
    });
    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i: any) => i.code)).toContain(ISSUE_CODES.TARGET_VERSION_INVALID);
  });

  it('refuses to bump when versions disagree', () => {
    writePkg(join(tmp, 'packages', 'cli'), basePkg('cli', '0.2.0'));
    const plan = buildReleasePlan(loadReleaseWorkspace(tmp), {
      kind: 'bump',
      bump: 'patch',
    });
    expect(plan.ok).toBe(false);
    const codes = plan.issues.map((i: any) => i.code);
    expect(codes).toContain(ISSUE_CODES.VERSION_MISMATCH);
    expect(codes).toContain(ISSUE_CODES.TARGET_VERSION_INVALID);
  });
});

// =============================================================================
// renderMarkdownPlan / buildJsonPlan
// =============================================================================

describe('render outputs', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = tmpRoot();
    writeCleanWorkspace(tmp);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('Markdown is byte-identical when called twice on the same plan', () => {
    const ws = loadReleaseWorkspace(tmp);
    const plan = buildReleasePlan(ws, { kind: 'bump', bump: 'patch' });
    const a = renderMarkdownPlan(plan);
    const b = renderMarkdownPlan(plan);
    expect(a).toBe(b);
  });

  it('Markdown contains the target, every package name, and the publish order', () => {
    const plan = buildReleasePlan(loadReleaseWorkspace(tmp), {
      kind: 'bump',
      bump: 'patch',
    });
    const md = renderMarkdownPlan(plan);
    expect(md).toContain('# PLC Copilot Release Plan');
    expect(md).toContain('Target version:');
    expect(md).toContain('0.1.1');
    for (const name of RELEASE_PUBLISH_ORDER) expect(md).toContain(name);
    expect(md).toContain('## Required gates');
    expect(md).toContain('## Publish order');
    expect(md).toContain('npm publish --dry-run packages/cli');
  });

  it('Markdown is timestamp-free', () => {
    const md = renderMarkdownPlan(
      buildReleasePlan(loadReleaseWorkspace(tmp), { kind: 'bump', bump: 'patch' }),
    );
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('JSON plan round-trips through JSON.stringify', () => {
    const plan = buildReleasePlan(loadReleaseWorkspace(tmp), {
      kind: 'bump',
      bump: 'patch',
    });
    const json = buildJsonPlan(plan);
    const round = JSON.parse(JSON.stringify(json));
    expect(round.ok).toBe(true);
    expect(round.target_version).toBe('0.1.1');
    expect(round.package_count).toBe(6);
  });
});

// =============================================================================
// applyReleasePlan (--write)
// =============================================================================

describe('applyReleasePlan', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = tmpRoot();
    writeCleanWorkspace(tmp);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rewrites every candidate version + every internal range', () => {
    const ws = loadReleaseWorkspace(tmp);
    const plan = buildReleasePlan(ws, { kind: 'bump', bump: 'minor' });
    const written = applyReleasePlan(ws, plan);
    expect(written.length).toBe(6);
    for (const dir of RELEASE_PACKAGE_DIRS) {
      const pkg = JSON.parse(
        readFileSync(join(tmp, 'packages', dir, 'package.json'), 'utf-8'),
      );
      expect(pkg.version).toBe('0.2.0');
      for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = pkg[section] ?? {};
        for (const [name, range] of Object.entries(deps)) {
          if (RELEASE_PUBLISH_ORDER.includes(name)) {
            expect(range).toBe('0.2.0');
          }
        }
      }
    }
  });

  it('leaves external deps (e.g. zod) untouched', () => {
    writePkg(
      join(tmp, 'packages', 'pir'),
      basePkg('pir', '0.1.0', { dependencies: { zod: '^3.23.8' } }),
    );
    const ws = loadReleaseWorkspace(tmp);
    const plan = buildReleasePlan(ws, { kind: 'bump', bump: 'patch' });
    applyReleasePlan(ws, plan);
    const pkg = JSON.parse(readFileSync(join(tmp, 'packages', 'pir', 'package.json'), 'utf-8'));
    expect(pkg.dependencies.zod).toBe('^3.23.8');
    expect(pkg.version).toBe('0.1.1');
  });

  it('writes a trailing newline', () => {
    const ws = loadReleaseWorkspace(tmp);
    const plan = buildReleasePlan(ws, { kind: 'bump', bump: 'patch' });
    applyReleasePlan(ws, plan);
    const raw = readFileSync(join(tmp, 'packages', 'pir', 'package.json'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('refuses to write a non-ok plan', () => {
    writePkg(join(tmp, 'packages', 'cli'), basePkg('cli', '0.1.0', { private: true }));
    const ws = loadReleaseWorkspace(tmp);
    const plan = buildReleasePlan(ws, { kind: 'bump', bump: 'patch' });
    expect(plan.ok).toBe(false);
    expect(() => applyReleasePlan(ws, plan)).toThrow(/refusing to write/);
  });
});

// =============================================================================
// checkPackManifest
// =============================================================================

describe('checkPackManifest', () => {
  function manifest(overrides: any = {}) {
    return [
      {
        name: '@plccopilot/cli',
        version: '0.1.0',
        files: [
          { path: 'package.json' },
          { path: 'dist/index.js' },
          { path: 'dist/index.d.ts' },
          { path: 'schemas/cli-result.schema.json' },
          { path: 'schemas/serialized-compiler-error.schema.json' },
          { path: 'schemas/generate-summary.schema.json' },
          { path: 'schemas/web-zip-summary.schema.json' },
        ],
        ...overrides,
      },
    ];
  }

  const expectedCli = {
    name: '@plccopilot/cli',
    version: '0.1.0',
    requiredEntries: [
      'package.json',
      'dist/index.js',
      'dist/index.d.ts',
      'schemas/cli-result.schema.json',
      'schemas/serialized-compiler-error.schema.json',
      'schemas/generate-summary.schema.json',
      'schemas/web-zip-summary.schema.json',
    ],
  };

  it('passes a clean CLI manifest', () => {
    expect(checkPackManifest(manifest(), expectedCli)).toEqual([]);
  });

  it('flags name mismatch', () => {
    const issues = checkPackManifest(manifest({ name: '@bad/name' }), expectedCli);
    expect(issues.map((i: any) => i.code)).toContain('PACK_NAME_MISMATCH');
  });

  it('flags version mismatch', () => {
    const issues = checkPackManifest(manifest({ version: '0.0.9' }), expectedCli);
    expect(issues.map((i: any) => i.code)).toContain('PACK_VERSION_MISMATCH');
  });

  it('flags missing required entry', () => {
    const m = manifest();
    m[0].files = m[0].files.filter((f: any) => f.path !== 'dist/index.js');
    const issues = checkPackManifest(m, expectedCli);
    expect(issues.map((i: any) => i.code)).toContain('PACK_REQUIRED_MISSING');
  });

  it('flags forbidden src/ prefix', () => {
    const m = manifest();
    m[0].files.push({ path: 'src/index.ts' });
    const issues = checkPackManifest(m, expectedCli);
    expect(issues.map((i: any) => i.code)).toContain('PACK_FORBIDDEN_PREFIX');
  });

  it('flags forbidden tsbuildinfo suffix', () => {
    const m = manifest();
    m[0].files.push({ path: '.tsbuildinfo' });
    const issues = checkPackManifest(m, expectedCli);
    expect(issues.map((i: any) => i.code)).toContain('PACK_FORBIDDEN_SUFFIX');
  });

  it('flags forbidden tsconfig.json exact match', () => {
    const m = manifest();
    m[0].files.push({ path: 'tsconfig.json' });
    const issues = checkPackManifest(m, expectedCli);
    expect(issues.map((i: any) => i.code)).toContain('PACK_FORBIDDEN_EXACT');
  });
});

// =============================================================================
// live repo integration
// =============================================================================

describe('live repo', () => {
  it('checkReleaseState passes with zero issues at version 0.1.0', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { issues, sharedVersion } = checkReleaseState(ws);
    expect(issues).toEqual([]);
    expect(sharedVersion).toBe('0.1.0');
  });

  it('default patch plan targets 0.1.1 and is ok', () => {
    const plan = buildReleasePlan(loadReleaseWorkspace(REPO_ROOT), {
      kind: 'bump',
      bump: 'patch',
    });
    expect(plan.ok).toBe(true);
    expect(plan.current_version).toBe('0.1.0');
    expect(plan.target_version).toBe('0.1.1');
    expect(plan.publish_order).toEqual([...RELEASE_PUBLISH_ORDER]);
  });
});
