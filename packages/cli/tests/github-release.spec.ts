// Sprint 69 — pure tests for the github-release helper lib + the
// create-github-release.yml workflow YAML. The actual `gh release
// create` runs on the GitHub runner; the helpers + workflow YAML are
// unit-tested without the network.
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
  GITHUB_RELEASE_DEFAULT_TITLE_PREFIX,
  GITHUB_RELEASE_PACKAGE_ORDER,
  GITHUB_RELEASE_TAG_PREFIX,
  assertNoNpmMutationSurface,
  buildGhReleaseCreateArgs,
  buildGhReleaseViewArgs,
  expectedGithubReleaseConfirmation,
  expectedGithubReleaseTag,
  expectedGithubReleaseTitle,
  parseGithubReleaseArgs,
  validateGithubReleaseAssets,
  validateGithubReleaseInputs,
  validateReleaseNotesForGithubRelease,
} from '../scripts/github-release-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const WORKFLOW_PATH = resolve(
  REPO_ROOT,
  '.github',
  'workflows',
  'create-github-release.yml',
);
const LIVE_RELEASE_NOTES = resolve(REPO_ROOT, 'docs', 'releases', '0.1.0.md');

// =============================================================================
// constants
// =============================================================================

describe('github-release constants', () => {
  it('tag prefix is `v`', () => {
    expect(GITHUB_RELEASE_TAG_PREFIX).toBe('v');
  });

  it('default title prefix is `PLC Copilot`', () => {
    expect(GITHUB_RELEASE_DEFAULT_TITLE_PREFIX).toBe('PLC Copilot');
  });

  it('release order matches the npm publish order exactly', () => {
    expect([...GITHUB_RELEASE_PACKAGE_ORDER]).toEqual([...RELEASE_PUBLISH_ORDER]);
  });

  it('expected confirmation has the canonical shape', () => {
    expect(expectedGithubReleaseConfirmation('0.1.0')).toBe('create GitHub release v0.1.0');
  });

  it('expected tag has the canonical shape', () => {
    expect(expectedGithubReleaseTag('0.1.0')).toBe('v0.1.0');
    expect(expectedGithubReleaseTag('1.2.3')).toBe('v1.2.3');
  });

  it('expected title combines the prefix + tag', () => {
    expect(expectedGithubReleaseTitle('0.1.0')).toBe('PLC Copilot v0.1.0');
  });
});

// =============================================================================
// parseGithubReleaseArgs
// =============================================================================

describe('parseGithubReleaseArgs', () => {
  it('returns null fields for empty argv', () => {
    const { options, errors } = parseGithubReleaseArgs([]);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({
      version: null,
      tag: null,
      confirm: '',
      notesFile: null,
      validateOnly: false,
      json: false,
      help: false,
    });
  });

  it('parses --version, --tag, --confirm (space + equals)', () => {
    const { options, errors } = parseGithubReleaseArgs([
      '--version', '0.1.0',
      '--tag=v0.1.0',
      '--confirm', 'create GitHub release v0.1.0',
    ]);
    expect(errors).toEqual([]);
    expect(options?.version).toBe('0.1.0');
    expect(options?.tag).toBe('v0.1.0');
    expect(options?.confirm).toBe('create GitHub release v0.1.0');
  });

  it('parses --notes-file and --validate-only / --json / --help', () => {
    expect(
      parseGithubReleaseArgs(['--notes-file', '/tmp/notes.md']).options?.notesFile,
    ).toBe('/tmp/notes.md');
    expect(parseGithubReleaseArgs(['--validate-only']).options?.validateOnly).toBe(true);
    expect(parseGithubReleaseArgs(['--json']).options?.json).toBe(true);
    expect(parseGithubReleaseArgs(['-h']).options?.help).toBe(true);
  });

  it('emits GITHUB_RELEASE_ARG_MISSING_VALUE for --version with no value', () => {
    const { errors } = parseGithubReleaseArgs(['--version']);
    expect(errors.map((e) => e.code)).toContain('GITHUB_RELEASE_ARG_MISSING_VALUE');
  });

  it('emits GITHUB_RELEASE_ARG_UNKNOWN on unknown args', () => {
    const { errors } = parseGithubReleaseArgs(['--banana']);
    expect(errors.map((e) => e.code)).toContain('GITHUB_RELEASE_ARG_UNKNOWN');
  });

  it('rejects --publish / --no-dry-run / --dry-run / --dist-tag / --yes / -y at parse time', () => {
    for (const flag of ['--publish', '--no-dry-run', '--dry-run', '--dist-tag', '--yes', '-y']) {
      const { errors } = parseGithubReleaseArgs([flag]);
      const codes = errors.map((e) => e.code);
      expect(codes).toContain('GITHUB_RELEASE_ARG_UNKNOWN');
    }
  });

  it('rejects non-array argv', () => {
    const { errors } = parseGithubReleaseArgs('nope' as any);
    expect(errors.map((e) => e.code)).toContain('GITHUB_RELEASE_ARG_INVALID');
  });
});

// =============================================================================
// validateGithubReleaseInputs (validate-only)
// =============================================================================

describe('validateGithubReleaseInputs (validate-only)', () => {
  it('passes when version + tag match the live workspace', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { issues } = validateGithubReleaseInputs(
      { version: '0.1.0', tag: 'v0.1.0', validateOnly: true },
      ws,
    );
    expect(issues).toEqual([]);
  });

  it('infers --version + --tag from the single-version workspace', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { options, issues } = validateGithubReleaseInputs(
      { validateOnly: true },
      ws,
    );
    expect(issues).toEqual([]);
    expect(options.version).toBe('0.1.0');
    expect(options.tag).toBe('v0.1.0');
  });

  it('fails on version mismatch with all 6 candidates', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { issues } = validateGithubReleaseInputs(
      { version: '9.9.9', tag: 'v9.9.9', validateOnly: true },
      ws,
    );
    const codes = issues.map((i) => i.code);
    expect(codes.filter((c) => c === 'GITHUB_RELEASE_VERSION_MISMATCH').length).toBe(6);
  });

  it('fails on invalid semver / tag mismatch', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const codes1 = validateGithubReleaseInputs(
      { version: 'oops', tag: 'voops', validateOnly: true },
      ws,
    ).issues.map((i) => i.code);
    expect(codes1).toContain('GITHUB_RELEASE_VERSION_INVALID');

    const codes2 = validateGithubReleaseInputs(
      { version: '0.1.0', tag: '0.1.0', validateOnly: true },
      ws,
    ).issues.map((i) => i.code);
    expect(codes2).toContain('GITHUB_RELEASE_TAG_MISMATCH');
  });

  it('does NOT require confirm in validate-only mode', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { issues } = validateGithubReleaseInputs(
      { version: '0.1.0', tag: 'v0.1.0', validateOnly: true },
      ws,
    );
    expect(issues).toEqual([]);
  });

  it('does NOT clobber defaults with parser-emitted nulls', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { options, issues } = validateGithubReleaseInputs(
      { version: '0.1.0', tag: null as any, validateOnly: true },
      ws,
    );
    expect(issues).toEqual([]);
    expect(options.tag).toBe('v0.1.0');
  });
});

// =============================================================================
// validateGithubReleaseInputs (real mode)
// =============================================================================

describe('validateGithubReleaseInputs (real mode)', () => {
  function realInputs(overrides: Record<string, unknown> = {}) {
    return {
      version: '0.1.0',
      tag: 'v0.1.0',
      confirm: 'create GitHub release v0.1.0',
      validateOnly: false,
      ...overrides,
    } as Parameters<typeof validateGithubReleaseInputs>[0];
  }

  it('passes with version + tag + confirm', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const { issues } = validateGithubReleaseInputs(realInputs(), ws);
    expect(issues).toEqual([]);
  });

  it('fails when confirm is missing', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    const codes = validateGithubReleaseInputs(realInputs({ confirm: '' }), ws).issues.map(
      (i) => i.code,
    );
    expect(codes).toContain('GITHUB_RELEASE_CONFIRM_REQUIRED');
  });

  it('fails when confirm differs by case or trailing whitespace', () => {
    const ws = loadReleaseWorkspace(REPO_ROOT);
    expect(
      validateGithubReleaseInputs(
        realInputs({ confirm: 'Create GitHub release v0.1.0' }),
        ws,
      ).issues.map((i) => i.code),
    ).toContain('GITHUB_RELEASE_CONFIRM_MISMATCH');
    expect(
      validateGithubReleaseInputs(
        realInputs({ confirm: 'create GitHub release v0.1.0 ' }),
        ws,
      ).issues.map((i) => i.code),
    ).toContain('GITHUB_RELEASE_CONFIRM_MISMATCH');
  });
});

// =============================================================================
// validateReleaseNotesForGithubRelease
// =============================================================================

describe('validateReleaseNotesForGithubRelease', () => {
  function cleanNotes(version = '0.1.0') {
    return [
      `# PLC Copilot ${version} Release Notes`,
      '',
      `Status: released and promoted to npm dist-tag latest.`,
      `Version: ${version}.`,
      '',
      'Packages:',
      ...GITHUB_RELEASE_PACKAGE_ORDER.map((name) => `- ${name}@${version}`),
    ].join('\n');
  }

  it('passes on clean post-promotion notes', () => {
    expect(validateReleaseNotesForGithubRelease(cleanNotes(), { version: '0.1.0' })).toEqual([]);
  });

  it('fails when notes still contain the pending phrase', () => {
    const broken = `${cleanNotes()}\n\nStatus: planned first npm release — pending\n`;
    const codes = validateReleaseNotesForGithubRelease(broken, { version: '0.1.0' }).map(
      (i) => i.code,
    );
    expect(codes).toContain('GITHUB_RELEASE_NOTES_PENDING_STATUS');
  });

  it('fails when notes still say "Do not promote to latest yet"', () => {
    const broken = `${cleanNotes()}\n\nDo not promote to latest yet.\n`;
    const codes = validateReleaseNotesForGithubRelease(broken, { version: '0.1.0' }).map(
      (i) => i.code,
    );
    expect(codes).toContain('GITHUB_RELEASE_NOTES_PENDING_STATUS');
  });

  it('fails when notes do not mention `latest`', () => {
    // Build a string that mentions every package and the version but
    // never contains the word "latest".
    const broken = [
      '# PLC Copilot 0.1.0 Release Notes',
      'Status: released under npm dist-tag next.',
      'Version: 0.1.0.',
      ...GITHUB_RELEASE_PACKAGE_ORDER.map((name) => `- ${name}@0.1.0`),
    ].join('\n');
    const codes = validateReleaseNotesForGithubRelease(broken, { version: '0.1.0' }).map(
      (i) => i.code,
    );
    expect(codes).toContain('GITHUB_RELEASE_NOTES_LATEST_MISSING');
  });

  it('fails when a candidate package is missing', () => {
    // Drop the cli package on purpose.
    const broken = [
      '# PLC Copilot 0.1.0 Release Notes',
      'Status: released and promoted to latest.',
      'Version: 0.1.0',
      ...GITHUB_RELEASE_PACKAGE_ORDER.filter((n) => n !== '@plccopilot/cli').map(
        (name) => `- ${name}@0.1.0`,
      ),
    ].join('\n');
    const codes = validateReleaseNotesForGithubRelease(broken, { version: '0.1.0' }).map(
      (i) => i.code,
    );
    expect(codes).toContain('GITHUB_RELEASE_NOTES_PACKAGE_MISSING');
  });

  it('fails when version string is missing from the body', () => {
    const broken = [
      '# PLC Copilot Release Notes',
      'Status: released and promoted to latest.',
      ...GITHUB_RELEASE_PACKAGE_ORDER.map((name) => `- ${name}`),
    ].join('\n');
    const codes = validateReleaseNotesForGithubRelease(broken, { version: '0.1.0' }).map(
      (i) => i.code,
    );
    expect(codes).toContain('GITHUB_RELEASE_NOTES_VERSION_MISSING');
  });

  it('reports MISSING when the markdown is empty / null / undefined', () => {
    expect(
      validateReleaseNotesForGithubRelease('', { version: '0.1.0' }).map((i) => i.code),
    ).toContain('GITHUB_RELEASE_NOTES_MISSING');
    expect(
      validateReleaseNotesForGithubRelease(null as any, { version: '0.1.0' }).map((i) => i.code),
    ).toContain('GITHUB_RELEASE_NOTES_MISSING');
  });

  it('passes the live docs/releases/0.1.0.md', () => {
    expect(existsSync(LIVE_RELEASE_NOTES)).toBe(true);
    const md = readFileSync(LIVE_RELEASE_NOTES, 'utf-8');
    expect(validateReleaseNotesForGithubRelease(md, { version: '0.1.0' })).toEqual([]);
  });
});

// =============================================================================
// validateGithubReleaseAssets
// =============================================================================

describe('validateGithubReleaseAssets', () => {
  function tarballPaths(count = 6) {
    return GITHUB_RELEASE_PACKAGE_ORDER.slice(0, count).map(
      (name, i) => `/tmp/${name.replace('/', '-')}-0.1.0.${i}.tgz`,
    );
  }

  it('passes on the canonical six-tarball + manifest set', () => {
    expect(
      validateGithubReleaseAssets({
        tarballPaths: tarballPaths(),
        manifestPath: '/tmp/manifest.json',
      }),
    ).toEqual([]);
  });

  it('fails when count is not 6', () => {
    const codes = validateGithubReleaseAssets({
      tarballPaths: tarballPaths(5),
      manifestPath: '/tmp/manifest.json',
    }).map((i) => i.code);
    expect(codes).toContain('GITHUB_RELEASE_ASSET_MISSING');
  });

  it('fails when a path is not a .tgz', () => {
    const bad = [...tarballPaths()];
    bad[0] = '/tmp/wrong.txt';
    const codes = validateGithubReleaseAssets({
      tarballPaths: bad,
      manifestPath: '/tmp/manifest.json',
    }).map((i) => i.code);
    expect(codes).toContain('GITHUB_RELEASE_ASSET_MISSING');
  });

  it('fails when manifestPath is missing or wrong', () => {
    expect(
      validateGithubReleaseAssets({
        tarballPaths: tarballPaths(),
        manifestPath: '',
      }).map((i) => i.code),
    ).toContain('GITHUB_RELEASE_ASSET_MISSING');
    expect(
      validateGithubReleaseAssets({
        tarballPaths: tarballPaths(),
        manifestPath: '/tmp/something.json',
      }).map((i) => i.code),
    ).toContain('GITHUB_RELEASE_ASSET_MISSING');
  });

  it('uses existsFn to check files on disk', () => {
    const codes = validateGithubReleaseAssets(
      {
        tarballPaths: tarballPaths(),
        manifestPath: '/tmp/manifest.json',
      },
      { existsFn: () => false },
    ).map((i) => i.code);
    expect(codes).toContain('GITHUB_RELEASE_ASSET_MISSING');
  });
});

// =============================================================================
// buildGhReleaseCreateArgs
// =============================================================================

describe('buildGhReleaseCreateArgs', () => {
  const ok = {
    version: '0.1.0',
    tag: 'v0.1.0',
    notesFile: 'docs/releases/0.1.0.md',
    assetPaths: [
      '/tmp/plccopilot-pir-0.1.0.tgz',
      '/tmp/plccopilot-codegen-core-0.1.0.tgz',
      '/tmp/plccopilot-codegen-codesys-0.1.0.tgz',
      '/tmp/plccopilot-codegen-rockwell-0.1.0.tgz',
      '/tmp/plccopilot-codegen-siemens-0.1.0.tgz',
      '/tmp/plccopilot-cli-0.1.0.tgz',
      '/tmp/manifest.json',
    ],
  };

  it('emits the canonical release-create argv', () => {
    const args = [...buildGhReleaseCreateArgs(ok)];
    expect(args[0]).toBe('release');
    expect(args[1]).toBe('create');
    expect(args[2]).toBe('v0.1.0');
    // The next entries are the assets in the order we passed them in.
    expect(args.slice(3, 3 + ok.assetPaths.length)).toEqual(ok.assetPaths);
    // Then --title <title> --notes-file <path>.
    const tail = args.slice(3 + ok.assetPaths.length);
    expect(tail).toEqual([
      '--title',
      'PLC Copilot v0.1.0',
      '--notes-file',
      'docs/releases/0.1.0.md',
    ]);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(buildGhReleaseCreateArgs(ok))).toBe(true);
  });

  it('uses an explicit title when one is passed', () => {
    const args = [...buildGhReleaseCreateArgs({ ...ok, title: 'Custom Title' })];
    const titleIdx = args.indexOf('--title');
    expect(args[titleIdx + 1]).toBe('Custom Title');
  });

  it('rejects bad version + bad tag + bad notes path + bad asset', () => {
    expect(() => buildGhReleaseCreateArgs({ ...ok, version: '0.1' })).toThrow();
    expect(() => buildGhReleaseCreateArgs({ ...ok, tag: '0.1.0' })).toThrow(
      /tag must equal "v0\.1\.0"/,
    );
    expect(() => buildGhReleaseCreateArgs({ ...ok, notesFile: 'docs/releases/0.1.0.txt' })).toThrow();
    expect(() => buildGhReleaseCreateArgs({ ...ok, assetPaths: [] })).toThrow();
    expect(() =>
      buildGhReleaseCreateArgs({
        ...ok,
        assetPaths: ['/tmp/wrong.txt'] as any,
      }),
    ).toThrow();
  });

  it('never emits an npm-mutation token', () => {
    const args = buildGhReleaseCreateArgs(ok);
    for (const banned of ['publish', '--publish', 'dist-tag', 'npm', '--no-dry-run']) {
      expect([...args]).not.toContain(banned);
    }
  });
});

// =============================================================================
// buildGhReleaseViewArgs
// =============================================================================

describe('buildGhReleaseViewArgs', () => {
  it('emits the canonical view argv', () => {
    expect([...buildGhReleaseViewArgs({ tag: 'v0.1.0' })]).toEqual([
      'release',
      'view',
      'v0.1.0',
    ]);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(buildGhReleaseViewArgs({ tag: 'v0.1.0' }))).toBe(true);
  });

  it('rejects an empty / non-string tag', () => {
    expect(() => buildGhReleaseViewArgs({ tag: '' as any })).toThrow();
    expect(() => buildGhReleaseViewArgs({ tag: 42 as any })).toThrow();
  });
});

// =============================================================================
// assertNoNpmMutationSurface
// =============================================================================

describe('assertNoNpmMutationSurface', () => {
  it('passes a clean gh argv', () => {
    expect(
      assertNoNpmMutationSurface([
        'release',
        'create',
        'v0.1.0',
        '/tmp/x.tgz',
        '--title',
        'PLC Copilot v0.1.0',
        '--notes-file',
        'docs/releases/0.1.0.md',
      ]),
    ).toBe(true);
  });

  it('throws on `publish`, `--publish`, `--no-dry-run`, `dist-tag`, `npm`', () => {
    for (const tok of ['publish', '--publish', '--no-dry-run', 'dist-tag', 'npm']) {
      expect(() => assertNoNpmMutationSurface([tok])).toThrow(/npm-mutation surface/);
    }
  });

  it('throws on non-array / non-string entries', () => {
    expect(() => assertNoNpmMutationSurface('nope' as any)).toThrow();
    expect(() => assertNoNpmMutationSurface([42 as any])).toThrow();
  });
});

// =============================================================================
// create-github-release.yml workflow safety
// =============================================================================

describe('create-github-release.yml workflow safety', () => {
  const has = existsSync(WORKFLOW_PATH);
  const yaml = has ? readFileSync(WORKFLOW_PATH, 'utf-8') : '';

  (has ? it : it.skip)('is workflow_dispatch only (no push/schedule/pull_request)', () => {
    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).not.toMatch(/^on:[\s\S]*push:/m);
    expect(yaml).not.toMatch(/^on:[\s\S]*schedule:/m);
    expect(yaml).not.toMatch(/^on:[\s\S]*pull_request:/m);
  });

  (has ? it : it.skip)('declares version / tag / registry / confirm inputs', () => {
    expect(yaml).toMatch(/^[ \t]+version:/m);
    expect(yaml).toMatch(/^[ \t]+tag:/m);
    expect(yaml).toMatch(/^[ \t]+registry:/m);
    expect(yaml).toMatch(/^[ \t]+confirm:/m);
  });

  (has ? it : it.skip)('default version is 0.1.0 and default tag is v0.1.0', () => {
    expect(yaml).toMatch(/version:[\s\S]*?default:\s*'0\.1\.0'/);
    expect(yaml).toMatch(/tag:[\s\S]*?default:\s*'v0\.1\.0'/);
  });

  (has ? it : it.skip)('top-level permissions are read-only', () => {
    expect(yaml).toMatch(/^permissions:\s*\n[ \t]+contents:\s*read/m);
  });

  (has ? it : it.skip)('only the create job grants contents: write', () => {
    // Two `contents:` lines (one read at top, one write inside the
    // create job). The write occurrence must appear after the
    // `create:` job heading. Header comments may also mention
    // `contents: write` in prose, so we match against the YAML
    // statement (un-prefixed by `#`) only.
    const writeMatch = yaml.match(/^[ \t]+contents:\s*write/m);
    expect(writeMatch).not.toBeNull();
    const writeIdx = yaml.indexOf(writeMatch![0]);
    const createJobHeading = yaml.match(/^  create:\s*$/m);
    expect(createJobHeading).not.toBeNull();
    const createIdx = yaml.indexOf(createJobHeading![0]);
    expect(createIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(createIdx);
  });

  (has ? it : it.skip)('preflight calls release:github --validate-only', () => {
    expect(yaml).toContain('release:github --validate-only');
  });

  (has ? it : it.skip)('preflight verifies version is on `latest`', () => {
    expect(yaml).toMatch(/release:npm-view[\s\S]*?--tag\s+latest/);
  });

  (has ? it : it.skip)('preflight runs release:check + publish:audit --check', () => {
    expect(yaml).toContain('release:check');
    expect(yaml).toContain('publish:audit --check');
  });

  (has ? it : it.skip)('create job builds packages + packs release artifacts', () => {
    expect(yaml).toContain('build:packages-base');
    expect(yaml).toContain('build:packages-vendor');
    expect(yaml).toContain('cli:build');
    expect(yaml).toContain('release:pack-artifacts');
  });

  (has ? it : it.skip)('create job invokes release:github with version + tag + confirm', () => {
    expect(yaml).toContain('release:github');
    expect(yaml).toMatch(/--version\s+"\$\{\{\s*inputs\.version\s*\}\}"/);
    expect(yaml).toMatch(/--tag\s+"\$\{\{\s*inputs\.tag\s*\}\}"/);
    expect(yaml).toMatch(/--confirm\s+"\$\{\{\s*inputs\.confirm\s*\}\}"/);
  });

  (has ? it : it.skip)('create job exports GH_TOKEN from secrets.GITHUB_TOKEN', () => {
    expect(yaml).toContain('GH_TOKEN:');
    expect(yaml).toContain('secrets.GITHUB_TOKEN');
  });

  (has ? it : it.skip)('does NOT shell out to `npm publish`', () => {
    const shellLines = yaml
      .split('\n')
      .map((l) => l.trimStart())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('name:'));
    expect(shellLines.filter((l) => /^npm\s+publish\b/.test(l))).toEqual([]);
  });

  (has ? it : it.skip)('does NOT shell out to `npm dist-tag`', () => {
    const shellLines = yaml
      .split('\n')
      .map((l) => l.trimStart())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('name:'));
    expect(shellLines.filter((l) => /^npm\s+dist-tag\b/.test(l))).toEqual([]);
  });

  (has ? it : it.skip)('checks out with fetch-depth: 0 in the create job', () => {
    expect(yaml).toMatch(/fetch-depth:\s*0/);
  });

  (has ? it : it.skip)('uses pnpm/action-setup + Node 24 in both jobs', () => {
    const pnpmSetups = yaml.match(/uses:\s*pnpm\/action-setup@v3/g) ?? [];
    expect(pnpmSetups.length).toBeGreaterThanOrEqual(2);
    const nodeSetups = yaml.match(/node-version:\s*24/g) ?? [];
    expect(nodeSetups.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// release-order coverage
// =============================================================================

describe('release-order coverage', () => {
  it('includes every release candidate exactly once', () => {
    const expected = Object.values(EXPECTED_PACKAGE_NAMES).filter((name) =>
      RELEASE_PUBLISH_ORDER.includes(name),
    );
    expect([...GITHUB_RELEASE_PACKAGE_ORDER].sort()).toEqual([...expected].sort());
    expect(GITHUB_RELEASE_PACKAGE_ORDER.length).toBe(
      new Set(GITHUB_RELEASE_PACKAGE_ORDER).size,
    );
  });
});
