// Sprint 66 / 67 — docs-contract tests for the first-publish
// execution pack. The publish itself is a manual GitHub Actions run;
// these tests guard the safety-critical phrases in the three
// companion docs against silent edits.
//
// Sprint 67 closeout flipped the docs from "pending" → "released
// under next" once the real publish succeeded. The assertions below
// pin the post-publish state: status flipped, six npm package URLs
// listed, postmortem marked complete, and `latest` promotion
// explicitly deferred (we never want a future operator to flip it
// without a workflow run).
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

  it('declares status as released under next (no longer pending)', () => {
    // Sprint 67 closeout: the publish succeeded, the doc must reflect that.
    expect(releaseNotes.toLowerCase()).toMatch(/status[^\n]*released under npm dist-tag/);
    expect(releaseNotes.toLowerCase()).toContain('next');
    // The pre-publish phrase is gone — guard against accidental rollback.
    expect(releaseNotes.toLowerCase()).not.toContain('planned first npm release — pending');
  });

  it('lists every release candidate with version 0.1.0', () => {
    for (const name of RELEASE_PUBLISH_ORDER) {
      expect(releaseNotes).toContain(`${name}@0.1.0`);
    }
  });

  it('declares the first dist-tag as `next`, not `latest`', () => {
    expect(releaseNotes).toMatch(/dist-tag[\s\S]*?`next`/i);
    // Explicit "do not promote to latest yet" guidance still present
    // post-release — promotion is intentionally deferred.
    expect(releaseNotes.toLowerCase()).toContain('do not promote to latest yet');
  });

  it('includes the six npm package URLs', () => {
    for (const name of RELEASE_PUBLISH_ORDER) {
      const expected = `https://www.npmjs.com/package/${name}/v/0.1.0`;
      expect(releaseNotes).toContain(expected);
    }
  });

  it('records that all three post-publish checks passed', () => {
    // The post-publish commands are still listed (for re-runs) AND
    // the verification table marks each as passed.
    expect(releaseNotes).toContain('pnpm release:provenance');
    expect(releaseNotes).toContain('pnpm release:npm-view');
    expect(releaseNotes).toContain('pnpm release:registry-smoke');
    // Sprint 67 closeout populates a results table with passing checks.
    const passedMarks = releaseNotes.match(/✅\s*passed/g) ?? [];
    expect(passedMarks.length).toBeGreaterThanOrEqual(3);
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

  it('records latest-promotion as a deferred decision', () => {
    // §5: "No — keep on next" ticked, "Yes" not ticked.
    expect(postmortem).toMatch(/-\s+\[x\][^\n]*No[^\n]*keep on `next`/i);
    expect(postmortem).toMatch(/-\s+\[ \][^\n]*Yes\b/i);
    // Six explicit `npm dist-tag add` lines remain available for when
    // the decision flips.
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
