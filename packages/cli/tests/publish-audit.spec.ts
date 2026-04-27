/**
 * Sprint 56 — pure-function tests for the publishability auditor.
 *
 * The audit logic ships as Node-builtins-only ESM at
 * `../scripts/publish-audit-lib.mjs`. Vitest's transformer happily
 * imports `.mjs` from a `.ts` spec; the helpers below stay generic so
 * future packages don't have to be added to the test suite by name.
 *
 * One small repo-integration test at the bottom asserts that the live
 * monorepo audit still finds the eight known packages and emits a
 * usable build order — that catches accidental regressions in
 * `discoverPackages` or `analyzePackage` against real package.json
 * files without hardcoding expected counts (those are allowed to
 * drift as later sprints land builds).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FINDING_CODES,
  analyzePackage,
  auditWorkspace,
  buildDependencyGraph,
  buildJsonReport,
  classifyPublishIntent,
  collectWorkspaceDependencies,
  discoverPackages,
  readPackageInfo,
  renderMarkdownReport,
  topoSort,
} from '../scripts/publish-audit-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'plccli-audit-'));
}

function writePkg(dir: string, json: object): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json, null, 2), 'utf-8');
}

// =============================================================================
// classifyPublishIntent
// =============================================================================

describe('classifyPublishIntent', () => {
  it('classifies a Vite app as "app"', () => {
    expect(
      classifyPublishIntent({ scripts: { dev: 'vite', build: 'vite build' } }, 'web'),
    ).toBe('app');
  });

  it('falls back to scripts.build mentioning vite', () => {
    expect(
      classifyPublishIntent({ scripts: { build: 'tsc --noEmit && vite build' } }, 'webish'),
    ).toBe('app');
  });

  it('classifies an integration-tests harness as "internal"', () => {
    expect(
      classifyPublishIntent(
        { name: '@plccopilot/codegen-integration-tests', scripts: { test: 'vitest run' } },
        'codegen-integration-tests',
      ),
    ).toBe('internal');
  });

  it('uses the directory name when name is missing', () => {
    expect(classifyPublishIntent({ scripts: { test: 'vitest' } }, 'codegen-integration-tests')).toBe(
      'internal',
    );
  });

  it('classifies a private codegen with exports as "publishable"', () => {
    expect(
      classifyPublishIntent(
        {
          name: '@plccopilot/codegen-core',
          private: true,
          exports: { '.': './src/index.ts' },
        },
        'codegen-core',
      ),
    ).toBe('publishable');
  });

  it('classifies a CLI with bin as "publishable"', () => {
    expect(
      classifyPublishIntent(
        { name: '@plccopilot/cli', bin: { plccopilot: './dist/index.js' } },
        'cli',
      ),
    ).toBe('publishable');
  });

  it('classifies a package with no main/exports/bin as "internal"', () => {
    expect(classifyPublishIntent({ name: '@plccopilot/something' }, 'something')).toBe('internal');
  });
});

// =============================================================================
// collectWorkspaceDependencies
// =============================================================================

describe('collectWorkspaceDependencies', () => {
  it('collects internal deps from every section', () => {
    const got = collectWorkspaceDependencies({
      dependencies: { '@plccopilot/pir': 'workspace:*', zod: '^3.23.8' },
      devDependencies: { '@plccopilot/codegen-core': 'workspace:*' },
      peerDependencies: { '@plccopilot/cli': '^1.0.0' },
    });
    expect(got).toHaveLength(3);
    const sections = got.map((d: any) => d.section).sort();
    expect(sections).toEqual(['dependencies', 'devDependencies', 'peerDependencies']);
  });

  it('flags workspace protocol vs non-workspace ranges', () => {
    const got = collectWorkspaceDependencies({
      dependencies: {
        '@plccopilot/pir': 'workspace:*',
        '@plccopilot/cli': '^1.0.0',
      },
    });
    const byName = Object.fromEntries(got.map((d: any) => [d.name, d]));
    expect(byName['@plccopilot/pir'].isWorkspaceProtocol).toBe(true);
    expect(byName['@plccopilot/cli'].isWorkspaceProtocol).toBe(false);
  });

  it('ignores non-internal dependencies', () => {
    expect(
      collectWorkspaceDependencies({
        dependencies: { zod: '^3.23.8', react: '^18.3.0' },
      }),
    ).toEqual([]);
  });
});

// =============================================================================
// analyzePackage — synthetic packages on disk
// =============================================================================

describe('analyzePackage', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = tmpRoot();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function setup(name: string, json: object): ReturnType<typeof readPackageInfo> {
    const dir = join(tmp, name);
    writePkg(dir, json);
    return readPackageInfo(dir);
  }

  it('flags private + workspace-runtime-dep + src-export on a publishable candidate', () => {
    const info = setup('codegen-core', {
      name: '@plccopilot/codegen-core',
      version: '0.1.0',
      private: true,
      type: 'module',
      exports: { '.': './src/index.ts' },
      dependencies: { '@plccopilot/pir': 'workspace:*' },
    });
    const a = analyzePackage(info);
    expect(a.intent).toBe('publishable');
    const codes = a.findings.map((f: any) => f.code);
    expect(codes).toContain(FINDING_CODES.PUBLISH_PRIVATE_FLAG);
    expect(codes).toContain(FINDING_CODES.PUBLISH_WORKSPACE_DEP);
    expect(codes).toContain(FINDING_CODES.PUBLISH_EXPORTS_POINTS_TO_SRC);
  });

  // ---------- Sprint 59: object-form exports ----------

  it('object exports with default→dist + types→dist emit no src/types warnings', () => {
    const dir = join(tmp, 'shipped');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.js'), 'export const x = 1;\n', 'utf-8');
    writeFileSync(join(dir, 'dist', 'index.d.ts'), 'export const x: number;\n', 'utf-8');
    writePkg(dir, {
      name: '@plccopilot/shipped',
      version: '0.1.0',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
      },
      files: ['dist'],
    });
    const a = analyzePackage(readPackageInfo(dir));
    const codes = a.findings.map((f: any) => f.code);
    expect(codes).not.toContain(FINDING_CODES.PUBLISH_EXPORTS_POINTS_TO_SRC);
    expect(codes).not.toContain(FINDING_CODES.PUBLISH_NO_TYPES);
    expect(codes).not.toContain(FINDING_CODES.PUBLISH_TYPES_MISSING_FILE);
    expect(codes).not.toContain(FINDING_CODES.PUBLISH_EXPORTS_TO_DIST_MISSING_DIST);
  });

  it('object exports with default→src still flag PUBLISH_EXPORTS_POINTS_TO_SRC', () => {
    const dir = join(tmp, 'sourcey');
    writePkg(dir, {
      name: '@plccopilot/sourcey',
      version: '0.1.0',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './src/index.ts',
        },
      },
      files: ['dist'],
    });
    const codes = analyzePackage(readPackageInfo(dir)).findings.map((f: any) => f.code);
    expect(codes).toContain(FINDING_CODES.PUBLISH_EXPORTS_POINTS_TO_SRC);
  });

  it('object exports with default→missing dist file → PUBLISH_EXPORTS_TO_DIST_MISSING_DIST', () => {
    const dir = join(tmp, 'forgot-build');
    writePkg(dir, {
      name: '@plccopilot/forgot-build',
      version: '0.1.0',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
      },
      files: ['dist'],
    });
    const codes = analyzePackage(readPackageInfo(dir)).findings.map((f: any) => f.code);
    expect(codes).toContain(FINDING_CODES.PUBLISH_EXPORTS_TO_DIST_MISSING_DIST);
  });

  it('blocks when bin path is missing on disk', () => {
    const info = setup('cli', {
      name: '@plccopilot/cli',
      version: '0.1.0',
      bin: { plccopilot: './dist/index.js' },
      files: ['dist'],
    });
    const codes = analyzePackage(info).findings.map((f: any) => f.code);
    expect(codes).toContain(FINDING_CODES.PUBLISH_BIN_MISSING_FILE);
  });

  it('blocks when types path is missing on disk', () => {
    const info = setup('typed', {
      name: '@plccopilot/typed',
      version: '0.1.0',
      exports: { '.': './dist/index.js' },
      types: './dist/index.d.ts',
      files: ['dist'],
    });
    const codes = analyzePackage(info).findings.map((f: any) => f.code);
    expect(codes).toContain(FINDING_CODES.PUBLISH_TYPES_MISSING_FILE);
  });

  it('blocks when exports point at dist but dist file is missing', () => {
    const info = setup('emitless', {
      name: '@plccopilot/emitless',
      version: '0.1.0',
      exports: { '.': './dist/index.js' },
      files: ['dist'],
    });
    const codes = analyzePackage(info).findings.map((f: any) => f.code);
    expect(codes).toContain(FINDING_CODES.PUBLISH_EXPORTS_TO_DIST_MISSING_DIST);
  });

  it('blocks when bin/exports touch dist/ but files lacks dist', () => {
    const info = setup('forgot-dist', {
      name: '@plccopilot/forgot-dist',
      version: '0.1.0',
      bin: { x: './dist/index.js' },
      files: ['schemas'],
    });
    const codes = analyzePackage(info).findings.map((f: any) => f.code);
    expect(codes).toContain(FINDING_CODES.PUBLISH_FILES_MISSING_DIST);
  });

  it('blocks when schema subpaths are exported but files lacks schemas', () => {
    const info = setup('schema-only', {
      name: '@plccopilot/schema-only',
      version: '0.1.0',
      exports: {
        '.': './dist/index.js',
        './schemas/foo.schema.json': './schemas/foo.schema.json',
      },
      files: ['dist'],
    });
    const codes = analyzePackage(info).findings.map((f: any) => f.code);
    expect(codes).toContain(FINDING_CODES.PUBLISH_FILES_MISSING_SCHEMAS);
  });

  it('emits no publish blockers for an internal harness', () => {
    const info = setup('codegen-integration-tests', {
      name: '@plccopilot/codegen-integration-tests',
      version: '0.1.0',
      private: true,
      scripts: { test: 'vitest run' },
      dependencies: { '@plccopilot/pir': 'workspace:*' },
    });
    const a = analyzePackage(info);
    expect(a.intent).toBe('internal');
    const blockers = a.findings.filter((f: any) => f.level === 'blocker');
    expect(blockers).toHaveLength(0);
    const codes = a.findings.map((f: any) => f.code);
    expect(codes).toContain(FINDING_CODES.INTEGRATION_TESTS_HARNESS);
  });

  it('emits no publish blockers for a Vite app', () => {
    const info = setup('web', {
      name: '@plccopilot/web',
      version: '0.1.0',
      private: true,
      scripts: { dev: 'vite', build: 'tsc --noEmit && vite build' },
      dependencies: { '@plccopilot/pir': 'workspace:*' },
    });
    const a = analyzePackage(info);
    expect(a.intent).toBe('app');
    expect(a.findings.filter((f: any) => f.level === 'blocker')).toHaveLength(0);
    expect(a.findings.map((f: any) => f.code)).toContain(FINDING_CODES.APP_PRIVATE);
  });

  it('does not flag workspace dep listed only as devDependency', () => {
    const info = setup('only-dev', {
      name: '@plccopilot/only-dev',
      version: '0.1.0',
      bin: { x: './dist/index.js' },
      files: ['dist'],
      devDependencies: { '@plccopilot/pir': 'workspace:*' },
    });
    const codes = analyzePackage(info).findings.map((f: any) => f.code);
    // Bin missing on disk still blocks; we only assert no workspace blocker fires.
    expect(codes).not.toContain(FINDING_CODES.PUBLISH_WORKSPACE_DEP);
  });

  // ---------- Sprint 67 hotfix: repository metadata ----------

  const REPO_URL = 'https://github.com/benatgomez19999-oss/plc_copilot_beta';

  function publishableTemplate(dir: string, overrides: any = {}): any {
    return {
      name: `@plccopilot/${dir}`,
      version: '0.1.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      },
      files: ['dist'],
      ...overrides,
    };
  }

  it('flags PUBLISH_REPOSITORY_MISSING when expectedRepositoryUrl is set and repo is absent', () => {
    const info = setup('cli', publishableTemplate('cli'));
    const codes = analyzePackage(info, { expectedRepositoryUrl: REPO_URL }).findings.map(
      (f: any) => f.code,
    );
    expect(codes).toContain(FINDING_CODES.PUBLISH_REPOSITORY_MISSING);
  });

  it('flags PUBLISH_REPOSITORY_URL_MISMATCH on the wrong URL', () => {
    const info = setup(
      'cli',
      publishableTemplate('cli', {
        repository: {
          type: 'git',
          url: 'https://github.com/wrong/place',
          directory: 'packages/cli',
        },
      }),
    );
    const codes = analyzePackage(info, { expectedRepositoryUrl: REPO_URL }).findings.map(
      (f: any) => f.code,
    );
    expect(codes).toContain(FINDING_CODES.PUBLISH_REPOSITORY_URL_MISMATCH);
    // No false positives on the directory itself.
    expect(codes).not.toContain(FINDING_CODES.PUBLISH_REPOSITORY_DIRECTORY_MISMATCH);
  });

  it('flags PUBLISH_REPOSITORY_URL_MISMATCH on the .git suffix variant', () => {
    // npm provenance rejects the `.git` suffix even when the rest of the
    // URL matches — this regression test pins that strict equality.
    const info = setup(
      'cli',
      publishableTemplate('cli', {
        repository: {
          type: 'git',
          url: `${REPO_URL}.git`,
          directory: 'packages/cli',
        },
      }),
    );
    const codes = analyzePackage(info, { expectedRepositoryUrl: REPO_URL }).findings.map(
      (f: any) => f.code,
    );
    expect(codes).toContain(FINDING_CODES.PUBLISH_REPOSITORY_URL_MISMATCH);
  });

  it('flags PUBLISH_REPOSITORY_DIRECTORY_MISMATCH on the wrong subpath', () => {
    const info = setup(
      'cli',
      publishableTemplate('cli', {
        repository: { type: 'git', url: REPO_URL, directory: 'packages/somewhere-else' },
      }),
    );
    const codes = analyzePackage(info, { expectedRepositoryUrl: REPO_URL }).findings.map(
      (f: any) => f.code,
    );
    expect(codes).toContain(FINDING_CODES.PUBLISH_REPOSITORY_DIRECTORY_MISMATCH);
  });

  it('does NOT flag any repository finding when url + directory match', () => {
    const info = setup(
      'cli',
      publishableTemplate('cli', {
        repository: { type: 'git', url: REPO_URL, directory: 'packages/cli' },
      }),
    );
    const codes = analyzePackage(info, { expectedRepositoryUrl: REPO_URL }).findings.map(
      (f: any) => f.code,
    );
    expect(codes).not.toContain(FINDING_CODES.PUBLISH_REPOSITORY_MISSING);
    expect(codes).not.toContain(FINDING_CODES.PUBLISH_REPOSITORY_URL_MISMATCH);
    expect(codes).not.toContain(FINDING_CODES.PUBLISH_REPOSITORY_DIRECTORY_MISMATCH);
  });

  it('skips the repository check entirely when expectedRepositoryUrl is omitted', () => {
    // Sprint 67 hotfix is opt-in: synthetic workspaces (with no root
    // package.json#repository) must keep passing without forging one.
    const info = setup('cli', publishableTemplate('cli'));
    const codes = analyzePackage(info).findings.map((f: any) => f.code);
    expect(codes).not.toContain(FINDING_CODES.PUBLISH_REPOSITORY_MISSING);
    expect(codes).not.toContain(FINDING_CODES.PUBLISH_REPOSITORY_URL_MISMATCH);
    expect(codes).not.toContain(FINDING_CODES.PUBLISH_REPOSITORY_DIRECTORY_MISMATCH);
  });
});

// =============================================================================
// buildDependencyGraph + topoSort
// =============================================================================

describe('buildDependencyGraph + topoSort', () => {
  function pkg(name: string, deps: string[]): any {
    return {
      pkg: {
        name,
        dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
      },
    };
  }

  it('orders pir before core before cli', () => {
    const packages = [
      pkg('@plccopilot/cli', ['@plccopilot/codegen-core', '@plccopilot/pir']),
      pkg('@plccopilot/codegen-core', ['@plccopilot/pir']),
      pkg('@plccopilot/pir', []),
    ];
    const graph = buildDependencyGraph(packages);
    const result = topoSort(graph, packages.map((p) => p.pkg.name));
    expect(result.cycle).toBeFalsy();
    const order = result.order ?? [];
    expect(order.indexOf('@plccopilot/pir')).toBeLessThan(
      order.indexOf('@plccopilot/codegen-core'),
    );
    expect(order.indexOf('@plccopilot/codegen-core')).toBeLessThan(
      order.indexOf('@plccopilot/cli'),
    );
  });

  it('uses alphabetical tie-break among equal-rank packages', () => {
    const packages = [
      pkg('@plccopilot/codegen-rockwell', ['@plccopilot/codegen-core']),
      pkg('@plccopilot/codegen-codesys', ['@plccopilot/codegen-core']),
      pkg('@plccopilot/codegen-core', []),
    ];
    const graph = buildDependencyGraph(packages);
    const result = topoSort(graph, packages.map((p) => p.pkg.name));
    expect(result.order?.[0]).toBe('@plccopilot/codegen-core');
    // Both vendors are equal-rank after core → alphabetical order.
    expect(result.order?.[1]).toBe('@plccopilot/codegen-codesys');
    expect(result.order?.[2]).toBe('@plccopilot/codegen-rockwell');
  });

  it('detects a cycle and returns the involved nodes', () => {
    const packages = [
      pkg('@plccopilot/a', ['@plccopilot/b']),
      pkg('@plccopilot/b', ['@plccopilot/a']),
    ];
    const graph = buildDependencyGraph(packages);
    const result = topoSort(graph, ['@plccopilot/a', '@plccopilot/b']);
    expect(result.order).toBeUndefined();
    expect((result.cycle ?? []).sort()).toEqual(['@plccopilot/a', '@plccopilot/b']);
  });

  it('ignores out-of-scope deps when sorting a subset', () => {
    const packages = [
      pkg('@plccopilot/cli', ['@plccopilot/pir']),
      pkg('@plccopilot/pir', []),
      pkg('@plccopilot/web', ['@plccopilot/pir']),
    ];
    const graph = buildDependencyGraph(packages);
    // Topo only over the two publishable names.
    const result = topoSort(graph, ['@plccopilot/cli', '@plccopilot/pir']);
    expect(result.order).toEqual(['@plccopilot/pir', '@plccopilot/cli']);
  });
});

// =============================================================================
// renderMarkdownReport — determinism + content
// =============================================================================

describe('renderMarkdownReport', () => {
  it('is byte-identical when called twice on the same audit', () => {
    const audit = auditWorkspace(REPO_ROOT);
    const a = renderMarkdownReport(audit);
    const b = renderMarkdownReport(audit);
    expect(a).toBe(b);
  });

  it('contains the summary table, package names, and the consumer-install path', () => {
    const audit = auditWorkspace(REPO_ROOT);
    const md = renderMarkdownReport(audit);
    expect(md).toContain('# PLC Copilot Publishability Audit');
    expect(md).toContain('## Summary');
    expect(md).toContain('## Recommended publish build order');
    expect(md).toContain('## Package matrix');
    expect(md).toContain('## Findings by package');
    expect(md).toContain('Minimum path to a consumer-install smoke');
    for (const name of [
      '@plccopilot/cli',
      '@plccopilot/codegen-core',
      '@plccopilot/codegen-codesys',
      '@plccopilot/codegen-rockwell',
      '@plccopilot/codegen-siemens',
      '@plccopilot/pir',
      '@plccopilot/web',
      '@plccopilot/codegen-integration-tests',
    ]) {
      expect(md).toContain(name);
    }
  });

  it('does not include any wall-clock timestamp', () => {
    const audit = auditWorkspace(REPO_ROOT);
    const md = renderMarkdownReport(audit);
    // ISO-8601 markers that would break --check determinism.
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(md.toLowerCase()).not.toContain('generated at');
  });
});

// =============================================================================
// buildJsonReport
// =============================================================================

describe('buildJsonReport', () => {
  it('emits a stable timestamp and a sorted package list', () => {
    const audit = auditWorkspace(REPO_ROOT);
    const json = buildJsonReport(audit, '2026-04-26T00:00:00.000Z');
    expect(json.generated_at).toBe('2026-04-26T00:00:00.000Z');
    const dirs = json.packages.map((p: any) => p.dir);
    expect([...dirs]).toEqual([...dirs].sort());
  });

  it('round-trips through JSON.stringify', () => {
    const audit = auditWorkspace(REPO_ROOT);
    const json = buildJsonReport(audit, '2026-04-26T00:00:00.000Z');
    const round = JSON.parse(JSON.stringify(json));
    expect(round.package_count).toBe(json.package_count);
    expect(round.build_order).toEqual(json.build_order);
  });
});

// =============================================================================
// discoverPackages on a synthetic root
// =============================================================================

describe('discoverPackages', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = tmpRoot();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns alphabetical package dirs and skips dirs without package.json', () => {
    writePkg(join(tmp, 'a-pkg'), { name: '@x/a' });
    writePkg(join(tmp, 'b-pkg'), { name: '@x/b' });
    mkdirSync(join(tmp, 'no-pkg-here'), { recursive: true });
    const got = discoverPackages(tmp);
    expect(got.map((p: string) => p.split(/[\\/]/).pop())).toEqual(['a-pkg', 'b-pkg']);
  });

  it('returns an empty list when no packages exist', () => {
    expect(discoverPackages(tmp)).toEqual([]);
  });
});

// =============================================================================
// auditWorkspace — live repo integration
// =============================================================================

describe('auditWorkspace (live repo)', () => {
  it('discovers the eight known packages and produces a usable build order', () => {
    const audit = auditWorkspace(REPO_ROOT);
    const names = audit.packages.map((p: any) => p.info.pkg.name).sort();
    expect(names).toEqual([
      '@plccopilot/cli',
      '@plccopilot/codegen-codesys',
      '@plccopilot/codegen-core',
      '@plccopilot/codegen-integration-tests',
      '@plccopilot/codegen-rockwell',
      '@plccopilot/codegen-siemens',
      '@plccopilot/pir',
      '@plccopilot/web',
    ]);
    expect(audit.summary.publishable_candidates).toBe(6);
    expect(audit.summary.internal).toBe(1);
    expect(audit.summary.apps).toBe(1);
    expect(audit.publishBuildOrder[0]).toBe('@plccopilot/pir');
    expect(audit.publishBuildOrder.at(-1)).toBe('@plccopilot/cli');
    expect(audit.cycle).toBeNull();
  });

  it('Sprint 67: every publish candidate carries the expected repository metadata', () => {
    const audit = auditWorkspace(REPO_ROOT);
    const candidates = audit.packages.filter((p: any) => p.intent === 'publishable');
    for (const a of candidates) {
      const codes: string[] = a.findings.map((f: any) => f.code);
      expect(codes).not.toContain(FINDING_CODES.PUBLISH_REPOSITORY_MISSING);
      expect(codes).not.toContain(FINDING_CODES.PUBLISH_REPOSITORY_URL_MISMATCH);
      expect(codes).not.toContain(FINDING_CODES.PUBLISH_REPOSITORY_DIRECTORY_MISMATCH);
    }
  });

  it('classifies @plccopilot/web as app and integration-tests as internal', () => {
    const audit = auditWorkspace(REPO_ROOT);
    const intentByName = new Map(
      audit.packages.map((p: any) => [p.info.pkg.name, p.intent]),
    );
    expect(intentByName.get('@plccopilot/web')).toBe('app');
    expect(intentByName.get('@plccopilot/codegen-integration-tests')).toBe('internal');
    expect(intentByName.get('@plccopilot/cli')).toBe('publishable');
  });
});
