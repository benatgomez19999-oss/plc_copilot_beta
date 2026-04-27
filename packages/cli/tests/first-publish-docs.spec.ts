// Sprint 66 — docs-contract tests for the first-publish execution
// pack. The publish itself is a manual GitHub Actions run; these
// tests guard the safety-critical phrases in the three companion
// docs against silent edits.
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
} from '../scripts/release-plan-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DOC_RELEASE_NOTES = resolve(REPO_ROOT, 'docs', 'releases', '0.1.0.md');
const DOC_POSTMORTEM = resolve(REPO_ROOT, 'docs', 'first-publish-postmortem.md');
const DOC_CHECKLIST = resolve(REPO_ROOT, 'docs', 'first-publish-checklist.md');

function read(path: string): string {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

const releaseNotes = read(DOC_RELEASE_NOTES);
const postmortem = read(DOC_POSTMORTEM);
const checklist = read(DOC_CHECKLIST);

// =============================================================================
// docs/releases/0.1.0.md
// =============================================================================

describe('docs/releases/0.1.0.md', () => {
  it('exists', () => {
    expect(existsSync(DOC_RELEASE_NOTES)).toBe(true);
  });

  it('declares status as pending / planned (not "released")', () => {
    // The first publish has not happened — release notes must say so.
    expect(releaseNotes.toLowerCase()).toMatch(/status[^\n]*planned first npm release/);
    expect(releaseNotes.toLowerCase()).toContain('pending');
  });

  it('lists every release candidate with version 0.1.0', () => {
    for (const name of RELEASE_PUBLISH_ORDER) {
      expect(releaseNotes).toContain(`${name}@0.1.0`);
    }
  });

  it('declares the first dist-tag as `next`, not `latest`', () => {
    expect(releaseNotes).toMatch(/dist-tag[\s\S]*?`next`/i);
    // Explicit "do not promote to latest yet" guidance present.
    expect(releaseNotes.toLowerCase()).toContain('do not promote to latest yet');
  });

  it('includes the post-publish verification commands', () => {
    expect(releaseNotes).toContain('pnpm release:provenance');
    expect(releaseNotes).toContain('pnpm release:npm-view');
    expect(releaseNotes).toContain('pnpm release:registry-smoke');
  });

  it('links the operational runbook + postmortem template', () => {
    expect(releaseNotes).toContain('first-publish-checklist.md');
    expect(releaseNotes).toContain('first-publish-postmortem.md');
  });
});

// =============================================================================
// docs/first-publish-postmortem.md
// =============================================================================

describe('docs/first-publish-postmortem.md', () => {
  it('exists and is a draft template', () => {
    expect(existsSync(DOC_POSTMORTEM)).toBe(true);
    expect(postmortem.toLowerCase()).toContain('status: draft');
  });

  it('includes the publish-workflow inputs the operator must enter', () => {
    expect(postmortem).toContain('`dry_run`');
    expect(postmortem).toContain('`false`');
    // The exact confirmation string is the safety gate against typos.
    expect(postmortem).toContain('publish @plccopilot 0.1.0');
  });

  it('captures the canonical publish order (every candidate, in order)', () => {
    const order = RELEASE_PUBLISH_ORDER.map((name) => postmortem.indexOf(name));
    for (const idx of order) {
      expect(idx).toBeGreaterThan(-1);
    }
    for (let i = 1; i < order.length; i++) {
      // Each name appears later in the document than the previous one.
      expect(order[i]).toBeGreaterThan(order[i - 1]);
    }
  });

  it('has a partial-publish recovery section', () => {
    expect(postmortem.toLowerCase()).toContain('partial publish');
    // Explicit warning to avoid blind retries.
    expect(postmortem.toLowerCase()).toMatch(
      /do not rerun[^\n]*same\s+`?version`?/i,
    );
  });

  it('records latest-promotion as a deferred decision', () => {
    expect(postmortem.toLowerCase()).toMatch(/promote to `?latest`?/i);
    // Six explicit `npm dist-tag add` lines, one per candidate, are
    // available for the operator to copy if they tick "yes".
    for (const name of RELEASE_PUBLISH_ORDER) {
      expect(postmortem).toContain(`npm dist-tag add ${name}@0.1.0`);
    }
  });

  it('mentions filling release notes + git tag as after-action items', () => {
    expect(postmortem.toLowerCase()).toContain('docs/releases/0.1.0.md');
    expect(postmortem.toLowerCase()).toContain('git tag');
  });
});

// =============================================================================
// docs/first-publish-checklist.md
// =============================================================================

describe('docs/first-publish-checklist.md', () => {
  it('exists', () => {
    expect(existsSync(DOC_CHECKLIST)).toBe(true);
  });

  it('mentions NPM_TOKEN and the npm-publish environment + reviewer', () => {
    expect(checklist).toContain('NPM_TOKEN');
    expect(checklist).toContain('npm-publish');
    expect(checklist.toLowerCase()).toMatch(/required reviewer|environment approver|reviewer/);
  });

  it('has explicit abort conditions before the real publish', () => {
    expect(checklist.toLowerCase()).toContain('abort conditions');
    // A handful of well-known triggers must each be called out.
    for (const phrase of [
      'pnpm run ci',
      'pnpm release:publish-dry-run',
      'pnpm release:publish-real --validate-only',
      'pnpm release:provenance',
      'NPM_TOKEN',
      'npm-publish',
      'confirm',
    ]) {
      expect(checklist).toContain(phrase);
    }
  });

  it('points at the postmortem + release notes companions', () => {
    expect(checklist).toContain('first-publish-postmortem.md');
    expect(checklist).toContain('releases/0.1.0.md');
  });

  it('walks through the canonical execution sequence (preflight → dry-run → real → post-publish)', () => {
    const phases = [
      'Local preflight',
      'GitHub dry-run',
      'Real publish',
      'Post-publish',
    ];
    let last = -1;
    for (const phase of phases) {
      const idx = checklist.indexOf(phase);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });
});

// =============================================================================
// cross-file invariants
// =============================================================================

describe('first-publish docs cross-invariants', () => {
  it('all three docs agree on version 0.1.0 and dist-tag next', () => {
    for (const text of [releaseNotes, postmortem, checklist]) {
      expect(text).toContain('0.1.0');
      expect(text).toMatch(/\bnext\b/);
    }
  });

  it('every release candidate appears in every doc', () => {
    for (const name of Object.values(EXPECTED_PACKAGE_NAMES)) {
      expect(releaseNotes).toContain(name);
      expect(postmortem).toContain(name);
    }
  });
});
