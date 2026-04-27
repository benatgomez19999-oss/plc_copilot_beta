// Sprint 62 — pure release-notes generator.
//
// Sits on top of release-plan-lib.mjs: a `ReleaseNotes` is a `ReleasePlan`
// re-shaped into the document an editor would hand to reviewers. The
// rendered Markdown / JSON are deterministic (no timestamp, stable
// ordering) so a future `--check`-style guard can compare bytes.

import {
  RELEASE_PACKAGE_DIRS,
  buildReleasePlan,
} from './release-plan-lib.mjs';

const HIGHLIGHT_TODO_ITEMS = Object.freeze([
  'TODO: summarize user-facing changes (CLI flags, JSON output shapes, schema additions).',
  'TODO: summarize compiler / codegen changes (lowering, diagnostics, generated artifacts).',
  'TODO: summarize internal contract changes (PIR, package surface, build configuration).',
]);

const COMPATIBILITY_NOTES = Object.freeze([
  'Node 24+ is required at runtime for the published CLI. The smoke chain proves install + bin works on a clean consumer.',
  'All published packages are pure ESM. Internal package ranges are exact strict semver and coordinated across the release set.',
  'The CLI ships `dist/index.js` + `dist/index.d.ts` and the four schema subpath exports; no source TypeScript is included in any tarball.',
]);

const VERIFICATION_CHECKLIST = Object.freeze([
  'pnpm run ci',
  'pnpm release:check',
  'pnpm release:pack-dry-run',
  'pnpm release:publish-dry-run',
  'pnpm consumer:install-smoke',
]);

/**
 * Build the release-notes object from the workspace + a target. Returns
 * `{ ok, current_version, target_version, title, packages, dependency_updates,
 *   publish_order, highlights, compatibility, checklist, issues }`.
 *
 * If the underlying plan is not ok (consistency or target issues), the
 * notes object surfaces those issues and `ok` is false. Markdown / JSON
 * rendering still works so CI can show the failure in context.
 */
export function buildReleaseNotes(workspace, target) {
  const plan = buildReleasePlan(workspace, target);
  return {
    ok: plan.ok,
    current_version: plan.current_version,
    target_version: plan.target_version,
    title: plan.target_version
      ? `PLC Copilot ${plan.target_version} Release Notes`
      : 'PLC Copilot Release Notes',
    package_count: plan.package_count,
    packages: plan.packages.map((p) => ({ ...p })),
    dependency_updates: plan.dependency_updates.map((u) => ({ ...u })),
    publish_order: [...plan.publish_order],
    highlights: [...HIGHLIGHT_TODO_ITEMS],
    compatibility: [...COMPATIBILITY_NOTES],
    checklist: [...VERIFICATION_CHECKLIST],
    issues: plan.issues.map((i) => ({ ...i })),
  };
}

/**
 * Deterministic Markdown — no timestamp, alphabetic where order is
 * not load-bearing, and the publish order preserved verbatim where it
 * is.
 */
export function renderMarkdownReleaseNotes(notes) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push(`# ${notes.title}`);
  push();
  push('> Generated scaffold — edit Highlights before a real publish.');
  push();
  push(`- Current version: \`${notes.current_version ?? '<unknown>'}\``);
  push(`- Target version: \`${notes.target_version ?? '<undetermined>'}\``);
  push(`- Packages: ${notes.package_count}`);
  push(`- Notes ok: ${notes.ok ? 'yes' : 'no'}`);
  push();

  if (notes.issues.length > 0) {
    push('## Plan issues');
    push();
    for (const i of notes.issues) {
      push(
        `- **${i.code}**${i.package ? ` _(${i.package})_` : ''}: ${i.message.replace(/\n/g, ' ')}`,
      );
      if (i.recommendation) push(`  - _Fix:_ ${i.recommendation}`);
    }
    push();
  }

  push('## Packages');
  push();
  for (const p of notes.packages) {
    const from = p.current_version ?? '<missing>';
    const to = p.target_version ?? '<undetermined>';
    push(`- \`${p.name}\`: ${from} → ${to}`);
  }
  push();

  push('## Highlights');
  push();
  for (const h of notes.highlights) push(`- ${h}`);
  push();

  push('## Compatibility');
  push();
  for (const c of notes.compatibility) push(`- ${c}`);
  push();

  push('## Verification checklist');
  push();
  for (const c of notes.checklist) push(`- [ ] \`${c}\``);
  push();

  push('## Publish order');
  push();
  notes.publish_order.forEach((name, i) => push(`${i + 1}. \`${name}\``));
  push();

  if (notes.dependency_updates.length > 0) {
    push('## Internal dependency updates');
    push();
    for (const u of notes.dependency_updates) {
      const from = u.from ?? '<missing>';
      const to = u.to ?? '<undetermined>';
      push(`- \`${u.package}\` (\`${u.section}\`): \`${u.dependency}\` ${from} → ${to}`);
    }
    push();
  }

  return lines.join('\n') + '\n';
}

export function buildJsonReleaseNotes(notes) {
  return {
    ok: notes.ok,
    title: notes.title,
    current_version: notes.current_version,
    target_version: notes.target_version,
    package_count: notes.package_count,
    packages: notes.packages.map((p) => ({ ...p })),
    dependency_updates: notes.dependency_updates.map((u) => ({ ...u })),
    publish_order: [...notes.publish_order],
    highlights: [...notes.highlights],
    compatibility: [...notes.compatibility],
    checklist: [...notes.checklist],
    issues: notes.issues.map((i) => ({ ...i })),
  };
}

export const _internal = Object.freeze({
  HIGHLIGHT_TODO_ITEMS,
  COMPATIBILITY_NOTES,
  VERIFICATION_CHECKLIST,
  RELEASE_PACKAGE_DIRS,
});
