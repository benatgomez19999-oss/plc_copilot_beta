/**
 * Sprint 61 — release planning + check tooling for the publish candidates.
 *
 * Pure / Node-built-ins-only. Two callers share this module:
 *   - `scripts/release-plan.mjs`             — CLI runner
 *   - `tests/release-plan.spec.ts`           — pure helper tests
 *
 * Scope is deliberately narrow: this is a *plan* + *consistency check*
 * tool. It does not run `npm publish`, does not tag, does not modify
 * the registry. The only mutation it can perform is `--write`-mode
 * version bumps on `package.json`, gated by a flag and never invoked
 * by the default `pnpm release:plan` flow.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Release inventory — explicit (not discovered) so a future package can't
// accidentally slip into the publish set without an intentional edit here.
// ---------------------------------------------------------------------------

export const RELEASE_PACKAGE_DIRS = Object.freeze([
  'pir',
  'codegen-core',
  'codegen-codesys',
  'codegen-rockwell',
  'codegen-siemens',
  'cli',
]);

export const EXPECTED_PACKAGE_NAMES = Object.freeze({
  pir: '@plccopilot/pir',
  'codegen-core': '@plccopilot/codegen-core',
  'codegen-codesys': '@plccopilot/codegen-codesys',
  'codegen-rockwell': '@plccopilot/codegen-rockwell',
  'codegen-siemens': '@plccopilot/codegen-siemens',
  cli: '@plccopilot/cli',
});

export const RELEASE_PUBLISH_ORDER = Object.freeze(
  RELEASE_PACKAGE_DIRS.map((d) => EXPECTED_PACKAGE_NAMES[d]),
);

export const ISSUE_CODES = Object.freeze({
  PACKAGE_DIR_MISSING: 'PACKAGE_DIR_MISSING',
  PACKAGE_JSON_UNREADABLE: 'PACKAGE_JSON_UNREADABLE',
  PACKAGE_NAME_MISMATCH: 'PACKAGE_NAME_MISMATCH',
  PACKAGE_PRIVATE: 'PACKAGE_PRIVATE',
  VERSION_INVALID: 'VERSION_INVALID',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  DEP_RANGE_INVALID: 'DEP_RANGE_INVALID',
  DEP_RANGE_MISMATCH: 'DEP_RANGE_MISMATCH',
  DEP_WORKSPACE_PROTOCOL: 'DEP_WORKSPACE_PROTOCOL',
  MAIN_NOT_DIST: 'MAIN_NOT_DIST',
  TYPES_NOT_DIST: 'TYPES_NOT_DIST',
  EXPORTS_DEFAULT_NOT_DIST: 'EXPORTS_DEFAULT_NOT_DIST',
  EXPORTS_TYPES_NOT_DIST: 'EXPORTS_TYPES_NOT_DIST',
  FILES_MISSING_DIST: 'FILES_MISSING_DIST',
  FILES_MISSING_SCHEMAS: 'FILES_MISSING_SCHEMAS',
  CLI_BIN_MISSING: 'CLI_BIN_MISSING',
  CLI_SCHEMA_EXPORT_MISSING: 'CLI_SCHEMA_EXPORT_MISSING',
  NPMRC_LINK_MISSING: 'NPMRC_LINK_MISSING',
  TARGET_VERSION_INVALID: 'TARGET_VERSION_INVALID',
  TARGET_NOT_INCREMENT: 'TARGET_NOT_INCREMENT',
});

// ---------------------------------------------------------------------------
// Semver — minimal X.Y.Z parser/bumper. Pre-release / build metadata are
// intentionally rejected for sprint 61; the project is at 0.1.0 and we
// don't want to accept ambiguous strings until it matters.
// ---------------------------------------------------------------------------

const STRICT_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const m = STRICT_SEMVER.exec(version);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

export function formatSemver(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function bumpVersion(version, kind) {
  const parsed = parseSemver(version);
  if (!parsed) {
    throw new Error(`bumpVersion: not a strict X.Y.Z version: ${JSON.stringify(version)}`);
  }
  switch (kind) {
    case 'patch':
      return formatSemver({ ...parsed, patch: parsed.patch + 1 });
    case 'minor':
      return formatSemver({ major: parsed.major, minor: parsed.minor + 1, patch: 0 });
    case 'major':
      return formatSemver({ major: parsed.major + 1, minor: 0, patch: 0 });
    default:
      throw new Error(`bumpVersion: unknown kind ${JSON.stringify(kind)}`);
  }
}

/**
 * Compare two strict-semver strings. Returns -1, 0, 1.
 * Throws if either is not strict semver.
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa) throw new Error(`compareSemver: invalid: ${JSON.stringify(a)}`);
  if (!pb) throw new Error(`compareSemver: invalid: ${JSON.stringify(b)}`);
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Workspace loading
// ---------------------------------------------------------------------------

function readPackageJson(pkgDir) {
  const jsonPath = join(pkgDir, 'package.json');
  if (!existsSync(jsonPath)) return null;
  const raw = readFileSync(jsonPath, 'utf-8');
  return { raw, parsed: JSON.parse(raw), path: jsonPath };
}

/**
 * Load the release workspace from `repoRoot`. Returns the candidate
 * package descriptors (in publish order) and the `.npmrc` text so
 * `checkReleaseState` can validate the link-workspace-packages setting
 * without re-reading files.
 */
export function loadReleaseWorkspace(repoRoot) {
  const candidates = [];
  for (const dir of RELEASE_PACKAGE_DIRS) {
    const pkgDir = resolve(repoRoot, 'packages', dir);
    if (!existsSync(pkgDir)) {
      candidates.push({ dir, packageDir: pkgDir, missing: true });
      continue;
    }
    let pkg = null;
    let parseError = null;
    try {
      pkg = readPackageJson(pkgDir);
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }
    candidates.push({
      dir,
      packageDir: pkgDir,
      missing: false,
      pkg,
      parseError,
    });
  }
  const npmrcPath = resolve(repoRoot, '.npmrc');
  const npmrc = existsSync(npmrcPath) ? readFileSync(npmrcPath, 'utf-8') : null;
  return { repoRoot, candidates, npmrc };
}

// ---------------------------------------------------------------------------
// Consistency check — collects every issue (does not stop on the first).
// ---------------------------------------------------------------------------

function makeIssue(code, packageName, message, recommendation) {
  return {
    level: 'error',
    code,
    package: packageName ?? null,
    message,
    recommendation: recommendation ?? null,
  };
}

function rootExportTargets(exportsField) {
  if (!exportsField || typeof exportsField !== 'object') return {};
  const entry = exportsField['.'];
  if (typeof entry === 'string') return { default: entry };
  if (entry && typeof entry === 'object') {
    return {
      types: typeof entry.types === 'string' ? entry.types : undefined,
      default:
        typeof entry.default === 'string'
          ? entry.default
          : typeof entry.import === 'string'
            ? entry.import
            : typeof entry.require === 'string'
              ? entry.require
              : undefined,
    };
  }
  return {};
}

const CLI_SCHEMA_EXPORTS = Object.freeze([
  './schemas/cli-result.schema.json',
  './schemas/serialized-compiler-error.schema.json',
  './schemas/generate-summary.schema.json',
  './schemas/web-zip-summary.schema.json',
]);

const RUNTIME_DEP_SECTIONS = Object.freeze([
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
]);

/**
 * Returns `{ issues, sharedVersion }` where `sharedVersion` is the
 * version every candidate currently agrees on (or `null` if they
 * disagree / any one is invalid). The shared version is the natural
 * bump source for plan generation.
 */
export function checkReleaseState(workspace) {
  const issues = [];
  const versions = new Map(); // dir -> version string

  for (const c of workspace.candidates) {
    if (c.missing) {
      issues.push(
        makeIssue(
          ISSUE_CODES.PACKAGE_DIR_MISSING,
          EXPECTED_PACKAGE_NAMES[c.dir],
          `packages/${c.dir} is missing on disk`,
          `Restore the directory or update RELEASE_PACKAGE_DIRS.`,
        ),
      );
      continue;
    }
    if (c.parseError || !c.pkg) {
      issues.push(
        makeIssue(
          ISSUE_CODES.PACKAGE_JSON_UNREADABLE,
          EXPECTED_PACKAGE_NAMES[c.dir],
          `packages/${c.dir}/package.json could not be read: ${c.parseError ?? 'missing'}`,
          'Fix the package.json before planning a release.',
        ),
      );
      continue;
    }
    const pkg = c.pkg.parsed;
    const expectedName = EXPECTED_PACKAGE_NAMES[c.dir];
    if (pkg.name !== expectedName) {
      issues.push(
        makeIssue(
          ISSUE_CODES.PACKAGE_NAME_MISMATCH,
          expectedName,
          `expected name "${expectedName}", got ${JSON.stringify(pkg.name)}`,
          `Update packages/${c.dir}/package.json#name.`,
        ),
      );
    }
    if (pkg.private === true) {
      issues.push(
        makeIssue(
          ISSUE_CODES.PACKAGE_PRIVATE,
          expectedName,
          `package is private:true; release candidates must be publishable.`,
          `Remove "private": true from packages/${c.dir}/package.json.`,
        ),
      );
    }
    if (parseSemver(pkg.version) === null) {
      issues.push(
        makeIssue(
          ISSUE_CODES.VERSION_INVALID,
          expectedName,
          `version is not strict X.Y.Z: ${JSON.stringify(pkg.version)}`,
          'Use a strict semver version.',
        ),
      );
    } else {
      versions.set(c.dir, pkg.version);
    }
    if (pkg.main !== './dist/index.js') {
      issues.push(
        makeIssue(
          ISSUE_CODES.MAIN_NOT_DIST,
          expectedName,
          `"main" must be "./dist/index.js", got ${JSON.stringify(pkg.main)}`,
          'Set "main" to "./dist/index.js".',
        ),
      );
    }
    if (pkg.types !== './dist/index.d.ts') {
      issues.push(
        makeIssue(
          ISSUE_CODES.TYPES_NOT_DIST,
          expectedName,
          `"types" must be "./dist/index.d.ts", got ${JSON.stringify(pkg.types)}`,
          'Set "types" to "./dist/index.d.ts".',
        ),
      );
    }
    const exportTargets = rootExportTargets(pkg.exports);
    if (exportTargets.default !== './dist/index.js') {
      issues.push(
        makeIssue(
          ISSUE_CODES.EXPORTS_DEFAULT_NOT_DIST,
          expectedName,
          `exports["."].default must be "./dist/index.js", got ${JSON.stringify(exportTargets.default)}`,
          'Use the standard { types, default } object pointing at dist.',
        ),
      );
    }
    if (exportTargets.types !== './dist/index.d.ts') {
      issues.push(
        makeIssue(
          ISSUE_CODES.EXPORTS_TYPES_NOT_DIST,
          expectedName,
          `exports["."].types must be "./dist/index.d.ts", got ${JSON.stringify(exportTargets.types)}`,
          'Use the standard { types, default } object pointing at dist.',
        ),
      );
    }
    if (!Array.isArray(pkg.files) || !pkg.files.includes('dist')) {
      issues.push(
        makeIssue(
          ISSUE_CODES.FILES_MISSING_DIST,
          expectedName,
          `"files" must include "dist", got ${JSON.stringify(pkg.files)}`,
          'Add "dist" to the files allowlist.',
        ),
      );
    }
    if (c.dir === 'cli') {
      if (!Array.isArray(pkg.files) || !pkg.files.includes('schemas')) {
        issues.push(
          makeIssue(
            ISSUE_CODES.FILES_MISSING_SCHEMAS,
            expectedName,
            `CLI "files" must include "schemas".`,
            'Add "schemas" to the files allowlist.',
          ),
        );
      }
      if (!pkg.bin || pkg.bin.plccopilot !== './dist/index.js') {
        issues.push(
          makeIssue(
            ISSUE_CODES.CLI_BIN_MISSING,
            expectedName,
            `CLI bin.plccopilot must be "./dist/index.js", got ${JSON.stringify(pkg.bin)}`,
            'Set bin.plccopilot to "./dist/index.js".',
          ),
        );
      }
      const exportKeys =
        pkg.exports && typeof pkg.exports === 'object' ? Object.keys(pkg.exports) : [];
      for (const subpath of CLI_SCHEMA_EXPORTS) {
        if (!exportKeys.includes(subpath)) {
          issues.push(
            makeIssue(
              ISSUE_CODES.CLI_SCHEMA_EXPORT_MISSING,
              expectedName,
              `CLI exports must declare ${JSON.stringify(subpath)}`,
              'Re-add the schema subpath export.',
            ),
          );
        }
      }
    }
  }

  // Shared version: every valid candidate agrees on the same X.Y.Z.
  const versionSet = new Set(versions.values());
  let sharedVersion = null;
  if (versionSet.size === 1 && versions.size === RELEASE_PACKAGE_DIRS.length) {
    sharedVersion = [...versionSet][0];
  } else if (versionSet.size > 1) {
    const lines = [...versions.entries()]
      .map(([dir, v]) => `  - ${EXPECTED_PACKAGE_NAMES[dir]}: ${v}`)
      .join('\n');
    issues.push(
      makeIssue(
        ISSUE_CODES.VERSION_MISMATCH,
        null,
        `release candidates do not share one version:\n${lines}`,
        'Bring every package to the same X.Y.Z (use `pnpm release:plan --version <X.Y.Z> --write`).',
      ),
    );
  }

  // Internal dependency ranges must equal sharedVersion (or, if sharedVersion
  // could not be determined, must at minimum match the dependent's own
  // version — we still emit MISMATCH issues to nudge alignment).
  for (const c of workspace.candidates) {
    if (c.missing || !c.pkg) continue;
    const pkg = c.pkg.parsed;
    const expectedName = EXPECTED_PACKAGE_NAMES[c.dir];
    const expectedVersion = sharedVersion ?? pkg.version;
    for (const section of RUNTIME_DEP_SECTIONS) {
      const block = pkg[section];
      if (!block || typeof block !== 'object') continue;
      for (const [depName, range] of Object.entries(block)) {
        if (!RELEASE_PUBLISH_ORDER.includes(depName)) continue;
        if (typeof range !== 'string') {
          issues.push(
            makeIssue(
              ISSUE_CODES.DEP_RANGE_INVALID,
              expectedName,
              `${section}["${depName}"] is not a string`,
              'Set the range to the shared release version.',
            ),
          );
          continue;
        }
        if (range.startsWith('workspace:')) {
          issues.push(
            makeIssue(
              ISSUE_CODES.DEP_WORKSPACE_PROTOCOL,
              expectedName,
              `${section}["${depName}"] uses workspace protocol "${range}"; npm pack does not rewrite this.`,
              `Replace with "${expectedVersion}".`,
            ),
          );
          continue;
        }
        if (parseSemver(range) === null) {
          issues.push(
            makeIssue(
              ISSUE_CODES.DEP_RANGE_INVALID,
              expectedName,
              `${section}["${depName}"] range "${range}" is not a strict X.Y.Z (sprint 61 policy)`,
              `Replace with "${expectedVersion}".`,
            ),
          );
          continue;
        }
        if (range !== expectedVersion) {
          issues.push(
            makeIssue(
              ISSUE_CODES.DEP_RANGE_MISMATCH,
              expectedName,
              `${section}["${depName}"] range "${range}" does not match release version "${expectedVersion}".`,
              `Replace with "${expectedVersion}".`,
            ),
          );
        }
      }
    }
  }

  // .npmrc must keep `link-workspace-packages=true` so dev still links
  // the workspace packages even though the ranges are explicit semver.
  if (!workspace.npmrc || !/(^|\n)\s*link-workspace-packages\s*=\s*true\b/.test(workspace.npmrc)) {
    issues.push(
      makeIssue(
        ISSUE_CODES.NPMRC_LINK_MISSING,
        null,
        '.npmrc must enable `link-workspace-packages=true` so pnpm links sibling packages despite explicit semver ranges.',
        'Add `link-workspace-packages=true` to .npmrc.',
      ),
    );
  }

  return { issues, sharedVersion };
}

// ---------------------------------------------------------------------------
// Plan generation
// ---------------------------------------------------------------------------

/**
 * Build a release plan from the loaded workspace + a target version
 * descriptor. `target` is one of:
 *   { kind: 'bump', bump: 'patch'|'minor'|'major' }
 *   { kind: 'exact', version: 'X.Y.Z' }
 *
 * Returns `{ ok, current_version, target_version, packages,
 *  dependency_updates, publish_order, gates, issues }`.
 *
 * If the workspace fails consistency, `issues` is non-empty and `ok`
 * is false. Plan fields are still populated when possible so a caller
 * can render a hint, but no `--write` should run.
 */
export function buildReleasePlan(workspace, target) {
  const { issues, sharedVersion } = checkReleaseState(workspace);
  const planIssues = [...issues];
  const currentVersion = sharedVersion;
  let targetVersion = null;

  if (target.kind === 'exact') {
    if (parseSemver(target.version) === null) {
      planIssues.push(
        makeIssue(
          ISSUE_CODES.TARGET_VERSION_INVALID,
          null,
          `--version ${JSON.stringify(target.version)} is not strict X.Y.Z`,
          'Use a strict semver target.',
        ),
      );
    } else {
      targetVersion = target.version;
      if (currentVersion !== null && compareSemver(target.version, currentVersion) <= 0) {
        planIssues.push(
          makeIssue(
            ISSUE_CODES.TARGET_NOT_INCREMENT,
            null,
            `--version ${target.version} is not greater than current ${currentVersion}.`,
            'Pick a strictly greater version.',
          ),
        );
      }
    }
  } else if (target.kind === 'bump') {
    if (currentVersion === null) {
      planIssues.push(
        makeIssue(
          ISSUE_CODES.TARGET_VERSION_INVALID,
          null,
          'cannot bump: candidates do not share one version yet.',
          'Use --version <X.Y.Z> --write to align them, then bump.',
        ),
      );
    } else {
      targetVersion = bumpVersion(currentVersion, target.bump);
    }
  } else {
    throw new Error(`buildReleasePlan: unknown target kind ${JSON.stringify(target?.kind)}`);
  }

  const packages = workspace.candidates.map((c) => ({
    dir: c.dir,
    name: EXPECTED_PACKAGE_NAMES[c.dir],
    current_version: c.missing || !c.pkg ? null : c.pkg.parsed.version ?? null,
    target_version: targetVersion,
  }));

  const dependency_updates = [];
  for (const c of workspace.candidates) {
    if (c.missing || !c.pkg) continue;
    const pkg = c.pkg.parsed;
    const expectedName = EXPECTED_PACKAGE_NAMES[c.dir];
    for (const section of RUNTIME_DEP_SECTIONS) {
      const block = pkg[section];
      if (!block || typeof block !== 'object') continue;
      for (const [depName, range] of Object.entries(block)) {
        if (!RELEASE_PUBLISH_ORDER.includes(depName)) continue;
        if (range !== targetVersion) {
          dependency_updates.push({
            package: expectedName,
            section,
            dependency: depName,
            from: typeof range === 'string' ? range : null,
            to: targetVersion,
          });
        }
      }
    }
  }
  dependency_updates.sort(
    (a, b) => a.package.localeCompare(b.package) || a.dependency.localeCompare(b.dependency),
  );

  const gates = [
    'pnpm build:packages-base',
    'pnpm base:dist-smoke',
    'pnpm build:packages-vendor',
    'pnpm vendor:dist-smoke',
    'pnpm cli:build',
    'pnpm schemas:check',
    'pnpm cli:smoke',
    'pnpm cli:pack-smoke',
    'pnpm cli:tarball-smoke',
    'pnpm consumer:install-smoke',
    'pnpm publish:audit',
    'pnpm run ci',
  ];

  return {
    ok: planIssues.length === 0 && targetVersion !== null,
    current_version: currentVersion,
    target_version: targetVersion,
    package_count: packages.length,
    packages,
    dependency_updates,
    publish_order: [...RELEASE_PUBLISH_ORDER],
    gates,
    issues: planIssues,
  };
}

// ---------------------------------------------------------------------------
// Markdown / JSON renderers
// ---------------------------------------------------------------------------

/**
 * Deterministic Markdown — no timestamp — so a future `--check`-style
 * comparison against a committed report stays byte-stable.
 */
export function renderMarkdownPlan(plan) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push('# PLC Copilot Release Plan');
  push();
  push('Generated by `pnpm release:plan`. Do not edit by hand.');
  push();
  push(`- Current version: \`${plan.current_version ?? '<unknown>'}\``);
  push(`- Target version: \`${plan.target_version ?? '<undetermined>'}\``);
  push(`- Packages: ${plan.package_count}`);
  push(`- Plan ok: ${plan.ok ? 'yes' : 'no'}`);
  push();

  if (plan.issues.length > 0) {
    push('## Issues');
    push();
    for (const i of plan.issues) {
      push(
        `- **${i.code}**${i.package ? ` _(${i.package})_` : ''}: ${i.message.replace(/\n/g, ' ')}`,
      );
      if (i.recommendation) push(`  - _Fix:_ ${i.recommendation}`);
    }
    push();
  }

  push('## Packages to publish');
  push();
  plan.packages.forEach((p, i) => {
    const from = p.current_version ?? '<missing>';
    const to = p.target_version ?? '<undetermined>';
    push(`${i + 1}. \`${p.name}\` ${from} → ${to}`);
  });
  push();

  push('## Internal dependency updates');
  push();
  if (plan.dependency_updates.length === 0) {
    push('_(none)_');
  } else {
    for (const u of plan.dependency_updates) {
      const from = u.from ?? '<missing>';
      const to = u.to ?? '<undetermined>';
      push(`- \`${u.package}\` (\`${u.section}\`): \`${u.dependency}\` ${from} → ${to}`);
    }
  }
  push();

  push('## Required gates');
  push();
  for (const g of plan.gates) push(`- \`${g}\``);
  push();

  push('## Publish order');
  push();
  plan.publish_order.forEach((name, i) => push(`${i + 1}. \`${name}\``));
  push();

  push('## Local dry-run publish (one tarball per package)');
  push();
  for (const dir of RELEASE_PACKAGE_DIRS) {
    push(`- \`npm publish --dry-run packages/${dir}\``);
  }
  push();
  push(
    '> The repo never runs `npm publish` (sprint 61 is plan-only). Use `pnpm release:pack-dry-run` to verify pack contents without contacting any registry.',
  );
  push();
  return lines.join('\n') + '\n';
}

export function buildJsonPlan(plan) {
  return {
    ok: plan.ok,
    current_version: plan.current_version,
    target_version: plan.target_version,
    package_count: plan.package_count,
    packages: plan.packages.map((p) => ({ ...p })),
    dependency_updates: plan.dependency_updates.map((u) => ({ ...u })),
    publish_order: [...plan.publish_order],
    gates: [...plan.gates],
    issues: plan.issues.map((i) => ({ ...i })),
  };
}

// ---------------------------------------------------------------------------
// --write — apply a plan to package.json files in place.
// ---------------------------------------------------------------------------

/**
 * Mutates each candidate's `package.json` to the plan's target version
 * and rewrites every internal runtime dependency range to the same
 * target. Non-internal deps are left alone. Writes pretty-printed
 * JSON with a trailing newline so diffs stay clean.
 *
 * Returns the list of file paths that were rewritten.
 */
export function applyReleasePlan(workspace, plan) {
  if (!plan.ok || !plan.target_version) {
    throw new Error('applyReleasePlan: refusing to write — plan is not ok.');
  }
  const target = plan.target_version;
  const written = [];
  for (const c of workspace.candidates) {
    if (c.missing || !c.pkg) continue;
    const pkg = c.pkg.parsed;
    let changed = false;
    if (pkg.version !== target) {
      pkg.version = target;
      changed = true;
    }
    for (const section of RUNTIME_DEP_SECTIONS) {
      const block = pkg[section];
      if (!block || typeof block !== 'object') continue;
      for (const depName of Object.keys(block)) {
        if (!RELEASE_PUBLISH_ORDER.includes(depName)) continue;
        if (block[depName] !== target) {
          block[depName] = target;
          changed = true;
        }
      }
    }
    if (changed) {
      writeFileSync(c.pkg.path, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
      written.push(c.pkg.path);
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// Pack manifest validation (used by --pack-dry-run after each `npm pack`).
// ---------------------------------------------------------------------------

const FORBIDDEN_PACK_PREFIXES = Object.freeze([
  'src/',
  'tests/',
  'scripts/',
  'node_modules/',
]);

const FORBIDDEN_PACK_SUFFIXES = Object.freeze(['.tsbuildinfo']);

const FORBIDDEN_PACK_EXACT = Object.freeze([
  'tsconfig.json',
  'tsconfig.build.json',
  'vitest.config.ts',
]);

/**
 * Check the parsed `npm pack --json` output for one package against
 * the release contract. Returns an array of issue objects (empty if
 * the manifest is fine). The runner formats them; the lib stays UI-free.
 */
export function checkPackManifest(manifest, expected) {
  const issues = [];
  if (!Array.isArray(manifest) || manifest.length === 0) {
    issues.push(
      makeIssue(
        'PACK_MANIFEST_SHAPE',
        expected.name,
        'npm pack JSON must be a non-empty array',
        'Re-run npm pack manually to inspect.',
      ),
    );
    return issues;
  }
  const entry = manifest[0];
  if (entry.name !== expected.name) {
    issues.push(
      makeIssue(
        'PACK_NAME_MISMATCH',
        expected.name,
        `pack reports name=${JSON.stringify(entry.name)} (expected ${expected.name})`,
        null,
      ),
    );
  }
  if (entry.version !== expected.version) {
    issues.push(
      makeIssue(
        'PACK_VERSION_MISMATCH',
        expected.name,
        `pack reports version=${JSON.stringify(entry.version)} (expected ${expected.version})`,
        null,
      ),
    );
  }
  const paths = (Array.isArray(entry.files) ? entry.files : [])
    .map((f) =>
      typeof f === 'object' && f && typeof f.path === 'string'
        ? f.path.replace(/\\/g, '/')
        : null,
    )
    .filter((p) => typeof p === 'string');
  const set = new Set(paths);
  for (const required of expected.requiredEntries) {
    if (!set.has(required)) {
      issues.push(
        makeIssue(
          'PACK_REQUIRED_MISSING',
          expected.name,
          `pack is missing required entry ${JSON.stringify(required)}`,
          'Update files / build before packing.',
        ),
      );
    }
  }
  for (const p of paths) {
    for (const prefix of FORBIDDEN_PACK_PREFIXES) {
      if (p.startsWith(prefix)) {
        issues.push(
          makeIssue(
            'PACK_FORBIDDEN_PREFIX',
            expected.name,
            `pack contains forbidden entry ${JSON.stringify(p)} (prefix ${prefix})`,
            null,
          ),
        );
      }
    }
    for (const exact of FORBIDDEN_PACK_EXACT) {
      if (p === exact) {
        issues.push(
          makeIssue(
            'PACK_FORBIDDEN_EXACT',
            expected.name,
            `pack contains forbidden file ${JSON.stringify(p)}`,
            null,
          ),
        );
      }
    }
    for (const suffix of FORBIDDEN_PACK_SUFFIXES) {
      if (p.endsWith(suffix)) {
        issues.push(
          makeIssue(
            'PACK_FORBIDDEN_SUFFIX',
            expected.name,
            `pack contains forbidden file ${JSON.stringify(p)} (suffix ${suffix})`,
            null,
          ),
        );
      }
    }
  }
  return issues;
}
