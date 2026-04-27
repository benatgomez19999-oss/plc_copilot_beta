// Sprint 62 — pure tests for the release-notes helper lib.
//
// (Single-line comments because a JSDoc here would close on `*/` inside
// an `@plccopilot/...` package path — same gotcha noted in
// release-plan.spec.ts.)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_PACKAGE_NAMES,
  loadReleaseWorkspace,
  RELEASE_PACKAGE_DIRS,
  RELEASE_PUBLISH_ORDER,
} from '../scripts/release-plan-lib.mjs';
import {
  buildJsonReleaseNotes,
  buildReleaseNotes,
  renderMarkdownReleaseNotes,
} from '../scripts/release-notes-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'plccli-release-notes-'));
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
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
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
    basePkg('codegen-core', version, { dependencies: { '@plccopilot/pir': version } }),
  );
  writePkg(
    join(repo, 'packages', 'codegen-codesys'),
    basePkg('codegen-codesys', version, {
      dependencies: { '@plccopilot/codegen-core': version, '@plccopilot/pir': version },
    }),
  );
  writePkg(
    join(repo, 'packages', 'codegen-rockwell'),
    basePkg('codegen-rockwell', version, {
      dependencies: { '@plccopilot/codegen-core': version, '@plccopilot/pir': version },
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

describe('buildReleaseNotes', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = tmpRoot();
    writeCleanWorkspace(tmp);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('produces ok=true patch notes targeting 0.1.1', () => {
    const notes = buildReleaseNotes(loadReleaseWorkspace(tmp), {
      kind: 'bump',
      bump: 'patch',
    });
    expect(notes.ok).toBe(true);
    expect(notes.title).toBe('PLC Copilot 0.1.1 Release Notes');
    expect(notes.current_version).toBe('0.1.0');
    expect(notes.target_version).toBe('0.1.1');
    expect(notes.package_count).toBe(6);
  });

  it('exposes the canonical publish order', () => {
    const notes = buildReleaseNotes(loadReleaseWorkspace(tmp), {
      kind: 'bump',
      bump: 'patch',
    });
    expect(notes.publish_order).toEqual([...RELEASE_PUBLISH_ORDER]);
  });

  it('includes TODO highlights, compatibility notes, and a checklist', () => {
    const notes = buildReleaseNotes(loadReleaseWorkspace(tmp), {
      kind: 'bump',
      bump: 'patch',
    });
    expect(notes.highlights.length).toBeGreaterThan(0);
    expect(notes.highlights[0].toLowerCase()).toContain('todo');
    expect(notes.compatibility.length).toBeGreaterThan(0);
    expect(notes.checklist).toContain('pnpm run ci');
    expect(notes.checklist).toContain('pnpm release:publish-dry-run');
  });

  it('rejects an invalid exact target with ok=false', () => {
    const notes = buildReleaseNotes(loadReleaseWorkspace(tmp), {
      kind: 'exact',
      version: 'oops',
    });
    expect(notes.ok).toBe(false);
    expect(notes.issues.length).toBeGreaterThan(0);
  });

  it('rejects an exact target that does not strictly increment', () => {
    const notes = buildReleaseNotes(loadReleaseWorkspace(tmp), {
      kind: 'exact',
      version: '0.1.0',
    });
    expect(notes.ok).toBe(false);
    expect(notes.issues.map((i) => i.code)).toContain('TARGET_NOT_INCREMENT');
  });
});

describe('renderMarkdownReleaseNotes', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = tmpRoot();
    writeCleanWorkspace(tmp);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('is byte-identical when called twice on the same notes', () => {
    const notes = buildReleaseNotes(loadReleaseWorkspace(tmp), {
      kind: 'bump',
      bump: 'patch',
    });
    expect(renderMarkdownReleaseNotes(notes)).toBe(renderMarkdownReleaseNotes(notes));
  });

  it('contains the title, every package name, and the verification checklist', () => {
    const md = renderMarkdownReleaseNotes(
      buildReleaseNotes(loadReleaseWorkspace(tmp), { kind: 'bump', bump: 'minor' }),
    );
    expect(md).toContain('# PLC Copilot 0.2.0 Release Notes');
    for (const name of RELEASE_PUBLISH_ORDER) expect(md).toContain(name);
    expect(md).toContain('## Highlights');
    expect(md).toContain('## Verification checklist');
    expect(md).toContain('pnpm run ci');
    expect(md).toContain('pnpm release:publish-dry-run');
  });

  it('does not include any wall-clock timestamp', () => {
    const md = renderMarkdownReleaseNotes(
      buildReleaseNotes(loadReleaseWorkspace(tmp), { kind: 'bump', bump: 'patch' }),
    );
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(md.toLowerCase()).not.toContain('generated at');
  });

  it('includes the scaffold warning so reviewers know to edit before publish', () => {
    const md = renderMarkdownReleaseNotes(
      buildReleaseNotes(loadReleaseWorkspace(tmp), { kind: 'bump', bump: 'patch' }),
    );
    expect(md).toContain('Generated scaffold');
  });

  it('shows plan issues at the top when ok=false', () => {
    const md = renderMarkdownReleaseNotes(
      buildReleaseNotes(loadReleaseWorkspace(tmp), { kind: 'exact', version: '0.0.9' }),
    );
    expect(md).toContain('## Plan issues');
    expect(md).toContain('TARGET_NOT_INCREMENT');
  });
});

describe('buildJsonReleaseNotes', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = tmpRoot();
    writeCleanWorkspace(tmp);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips through JSON.stringify', () => {
    const notes = buildReleaseNotes(loadReleaseWorkspace(tmp), {
      kind: 'bump',
      bump: 'patch',
    });
    const json = buildJsonReleaseNotes(notes);
    const round = JSON.parse(JSON.stringify(json));
    expect(round.ok).toBe(true);
    expect(round.target_version).toBe('0.1.1');
    expect(round.publish_order).toEqual([...RELEASE_PUBLISH_ORDER]);
  });

  it('keeps highlights / compatibility / checklist arrays intact', () => {
    const json = buildJsonReleaseNotes(
      buildReleaseNotes(loadReleaseWorkspace(tmp), { kind: 'bump', bump: 'patch' }),
    );
    expect(json.highlights.length).toBeGreaterThan(0);
    expect(json.compatibility.length).toBeGreaterThan(0);
    expect(json.checklist.length).toBeGreaterThan(0);
  });
});

describe('live repo', () => {
  it('builds ok=true patch notes against the real workspace', () => {
    const notes = buildReleaseNotes(loadReleaseWorkspace(REPO_ROOT), {
      kind: 'bump',
      bump: 'patch',
    });
    expect(notes.ok).toBe(true);
    expect(notes.current_version).toBe('0.1.0');
    expect(notes.target_version).toBe('0.1.1');
    expect(notes.publish_order.length).toBe(RELEASE_PACKAGE_DIRS.length);
  });
});
