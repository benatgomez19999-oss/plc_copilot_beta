// Sprint 66 / 67 / 68 — docs-contract tests for the first-publish
// execution pack. The publish itself is a manual GitHub Actions run;
// these tests guard the safety-critical phrases in the three
// companion docs against silent edits.
//
// Sprint 67 closeout flipped the docs from "pending" → "released
// under next" once the real publish succeeded.
// Sprint 68 closeout flipped them again from "released under next"
// → "released and promoted to latest" once the promote-latest
// workflow ran and `npm view --tag latest` confirmed every candidate
// resolves to the same version. The assertions below pin the
// post-promotion state and explicitly forbid a regression to either
// "pending" or "do not promote to latest yet" wording.
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

  it('declares status as released and promoted to latest (no longer pending or next-only)', () => {
    // Sprint 68 closeout: the promotion ran, the doc must reflect that.
    expect(releaseNotes.toLowerCase()).toMatch(/status[^\n]*released and promoted to npm dist-tag/);
    expect(releaseNotes.toLowerCase()).toContain('latest');
    // The earlier states must be gone — guard against accidental rollback.
    expect(releaseNotes.toLowerCase()).not.toContain('planned first npm release — pending');
    expect(releaseNotes.toLowerCase()).not.toContain('do not promote to latest yet');
  });

  it('lists every release candidate with version 0.1.0', () => {
    for (const name of RELEASE_PUBLISH_ORDER) {
      expect(releaseNotes).toContain(`${name}@0.1.0`);
    }
  });

  it('records both dist-tags resolve to 0.1.0 (initial under next, promoted to latest)', () => {
    // Both phases of the release should be visible in the release
    // notes so a future reader can reconstruct the timeline:
    //   1. Sprint 67 staged 0.1.0 under `next`
    //   2. Sprint 68 promoted to `latest`.
    const lower = releaseNotes.toLowerCase();
    expect(lower).toMatch(/initial release[^\n]*next|under the `next` dist-tag|under `next`/);
    expect(lower).toMatch(/promot(ed|ion) to[^\n]*`?latest`?/);
  });

  it('includes the six npm package URLs', () => {
    for (const name of RELEASE_PUBLISH_ORDER) {
      const expected = `https://www.npmjs.com/package/${name}/v/0.1.0`;
      expect(releaseNotes).toContain(expected);
    }
  });

  it('records that all three post-publish checks passed (Sprint 67) AND the post-promotion checks passed (Sprint 68)', () => {
    // Post-publish (sprint 67) commands listed.
    expect(releaseNotes).toContain('pnpm release:provenance');
    expect(releaseNotes).toContain('pnpm release:npm-view');
    expect(releaseNotes).toContain('pnpm release:registry-smoke');
    // Sprint 68 adds a second results table for the latest-tag
    // verification — there should now be ≥5 ✅ passed marks across
    // the two tables.
    const passedMarks = releaseNotes.match(/✅\s*passed/g) ?? [];
    expect(passedMarks.length).toBeGreaterThanOrEqual(5);
    // Explicit reference to the post-promotion verification with
    // `--tag latest`.
    expect(releaseNotes).toMatch(/release:npm-view[\s\S]*?--tag\s+latest/);
  });

  it('does NOT claim deep provenance attestation verification', () => {
    // Sprint 65 stub only verifies the publish path is *configured* for
    // provenance. The Sigstore Fulcio chain walk is future work and the
    // release notes must keep that distinction visible. The "not"
    // appears bold (`**not**`) in the rendered doc, hence the regex.
    expect(releaseNotes.toLowerCase()).toMatch(
      /\*?\*?not\*?\*?\s+implemented yet/,
    );
  });

  it('links the operational runbook + postmortem', () => {
    expect(releaseNotes).toContain('first-publish-checklist.md');
    expect(releaseNotes).toContain('first-publish-postmortem.md');
  });

  it('records the GitHub Release as created (Sprint 69 closeout) — no longer pending', () => {
    // Sprint 69 closeout flipped the GitHub Release section from
    // pending → created. The doc must reflect that the v0.1.0 git tag
    // and matching GitHub Release page now exist.
    const lower = releaseNotes.toLowerCase();
    expect(lower).toMatch(/status[^\n]*created[^\n]*github release[^\n]*v0\.1\.0/);
    // Earlier pending wording must be gone — guard against rollback.
    expect(lower).not.toMatch(/^[ \t>]*\*?\*?status:\s*pending\b/m);
    expect(lower).not.toContain('the operator dispatch that');
    // The literal v0.1.0 tag name must be present.
    expect(releaseNotes).toContain('`v0.1.0`');
    expect(releaseNotes).toContain('PLC Copilot v0.1.0');
  });

  it('exposes URL fields for the GitHub Release, tag, and create-github-release workflow run', () => {
    // The fields must exist as table rows (operator pastes the real
    // URLs into their own checkout); the test asserts the row labels
    // are present, not the URL contents.
    expect(releaseNotes).toMatch(/\| Release URL \|[^|]*\|/);
    expect(releaseNotes).toMatch(/\| Tag URL \|[^|]*\|/);
    expect(releaseNotes).toMatch(/\| Workflow run \(create-github-release\) \|[^|]*\|/);
    // Release-creation date is a real, absolute date (post-promotion).
    expect(releaseNotes).toMatch(/\| Release-creation date \|\s*2026-04-2[78]\s*\|/);
  });

  it('lists the six release tarball assets + manifest.json on the GitHub Release', () => {
    // Sprint 69 attached six .tgz + manifest.json. Each must appear in
    // the "Release assets (attached)" block. Filenames follow the
    // canonical npm-pack scope-replacement (the `/` becomes `-`).
    for (const name of RELEASE_PUBLISH_ORDER) {
      const fileName = `${name.replace('/', '-')}-0.1.0.tgz`;
      expect(releaseNotes).toContain(fileName);
    }
    expect(releaseNotes).toContain('manifest.json');
    // Section header must be in the post-creation tense.
    expect(releaseNotes).toMatch(/Release assets \(attached\)/);
    expect(releaseNotes).not.toMatch(/Release assets \(planned\)/);
  });

  it('records the workflow inputs verbatim for postmortem traceability', () => {
    // Same convention as the publish + promote postmortems — the four
    // workflow inputs must be visible so a future operator can grep
    // for the literal confirm string.
    expect(releaseNotes).toContain('create GitHub release v0.1.0');
    expect(releaseNotes).toMatch(/version:\s*0\.1\.0/);
    expect(releaseNotes).toMatch(/tag:\s*v0\.1\.0/);
    expect(releaseNotes).toMatch(/registry:\s*https:\/\/registry\.npmjs\.org/);
  });
});

// =============================================================================
// docs/first-publish-postmortem.md
// =============================================================================

describe('docs/first-publish-postmortem.md', () => {
  it('exists and reports the run as complete + successful', () => {
    expect(existsSync(DOC_POSTMORTEM)).toBe(true);
    // Sprint 67 closeout flipped the status block from `draft` to
    // `complete — first publish successful`.
    expect(postmortem.toLowerCase()).toContain('status: complete');
    expect(postmortem.toLowerCase()).toContain('first publish successful');
    expect(postmortem.toLowerCase()).not.toContain('status: draft');
  });

  it('records the real publish workflow inputs verbatim', () => {
    expect(postmortem).toContain('`dry_run`');
    expect(postmortem).toContain('`false`');
    // The confirmation string is the safety gate against typos and
    // it must appear exactly as the operator typed it.
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

  it('reports all 6 packages published with no partial publish', () => {
    expect(postmortem.toLowerCase()).toMatch(/all 6 packages published/);
    // The "Partial publish" outcome bullet must NOT be ticked.
    expect(postmortem).not.toMatch(/-\s+\[x\]\s+Partial publish/i);
  });

  it('lists the six published npm package URLs', () => {
    for (const name of RELEASE_PUBLISH_ORDER) {
      const expected = `https://www.npmjs.com/package/${name}/v/0.1.0`;
      expect(postmortem).toContain(expected);
    }
  });

  it('records each post-publish check as passed (provenance / npm-view / registry-smoke)', () => {
    expect(postmortem).toContain('release:provenance');
    expect(postmortem).toContain('release:npm-view');
    expect(postmortem).toContain('release:registry-smoke');
    // Each results bullet must be ticked.
    expect(postmortem).toMatch(/-\s+\[x\][^\n]*release:provenance/);
    expect(postmortem).toMatch(/-\s+\[x\][^\n]*release:npm-view/);
    expect(postmortem).toMatch(/-\s+\[x\][^\n]*release:registry-smoke/);
  });

  it('records latest-promotion as completed (Sprint 68 closeout)', () => {
    // §5: the "Yes" tickbox is now ticked; the "No" tickbox is empty.
    expect(postmortem).toMatch(/-\s+\[x\][^\n]*Yes[^\n]*promotion is justified and completed/i);
    expect(postmortem).toMatch(/-\s+\[ \][^\n]*No[^\n]*keep on `next`/i);
    // Section explicitly mentions Sprint 68 closeout + the workflow.
    expect(postmortem).toContain('Sprint 68 closeout');
    expect(postmortem).toMatch(/Promote latest/i);
    // The exact promote-latest confirmation string is recorded so a
    // future operator can grep for the literal value.
    expect(postmortem).toContain('promote @plccopilot 0.1.0 to latest');
    // Six explicit `npm dist-tag add` recovery commands remain
    // available even after the promotion (kept for future operators
    // who might need to re-issue moves manually).
    for (const name of RELEASE_PUBLISH_ORDER) {
      expect(postmortem).toContain(`npm dist-tag add ${name}@0.1.0`);
    }
  });

  it('documents the four issues encountered before final success', () => {
    // Each subsection in §4 captures one of the iterations the operator
    // hit before the final successful publish.
    const lower = postmortem.toLowerCase();
    expect(lower).toMatch(/private repo|repository[^\n]*public/i);
    expect(lower).toMatch(/confirm[\s-]string mismatch/i);
    expect(lower).toMatch(/repository\.url[\s\S]*provenance/i);
    expect(lower).toMatch(/(publish-audit|declaration|TS2554)/i);
  });

  it('mentions release notes + git tag as after-action items', () => {
    expect(postmortem.toLowerCase()).toContain('releases/0.1.0.md');
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
