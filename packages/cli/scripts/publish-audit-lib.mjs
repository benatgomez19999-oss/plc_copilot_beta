/**
 * Sprint 56 — publishability auditor for the PLC Copilot monorepo.
 *
 * This module is the pure / Node-built-ins-only logic behind both
 * `pnpm publish:audit` and the Vitest spec. It deliberately does NOT
 * mutate any package — it only reads `packages/<dir>/package.json`,
 * checks a few well-known files on disk, and emits findings.
 *
 * Two consumers:
 *   - `scripts/publish-audit.mjs`          — the CLI runner
 *   - `tests/publish-audit.spec.ts`        — pure-function tests
 *
 * Design notes:
 *   - Markdown output is *deterministic* (no timestamp, stable ordering)
 *     so `pnpm publish:audit --check` can compare byte-for-byte against
 *     `docs/publishability-audit.md`.
 *   - JSON output IS timestamped (callers parse it fresh).
 *   - Discovery is generic: any future `packages/<dir>` with a
 *     package.json gets audited automatically.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Finding levels & codes
// ---------------------------------------------------------------------------

export const FINDING_LEVELS = Object.freeze(['blocker', 'warning', 'info']);

// Stable code list — referenced from tests + report. Keep alphabetised.
export const FINDING_CODES = Object.freeze({
  APP_PRIVATE: 'APP_PRIVATE',
  HAS_BIN: 'HAS_BIN',
  HAS_SCHEMA_EXPORTS: 'HAS_SCHEMA_EXPORTS',
  INTEGRATION_TESTS_HARNESS: 'INTEGRATION_TESTS_HARNESS',
  INTERNAL_DEP: 'INTERNAL_DEP',
  INTERNAL_PRIVATE: 'INTERNAL_PRIVATE',
  PUBLISH_BIN_MISSING_FILE: 'PUBLISH_BIN_MISSING_FILE',
  PUBLISH_EXPORTS_POINTS_TO_SRC: 'PUBLISH_EXPORTS_POINTS_TO_SRC',
  PUBLISH_EXPORTS_TO_DIST_MISSING_DIST: 'PUBLISH_EXPORTS_TO_DIST_MISSING_DIST',
  PUBLISH_FILES_INCLUDES_SRC: 'PUBLISH_FILES_INCLUDES_SRC',
  PUBLISH_FILES_MISSING_DIST: 'PUBLISH_FILES_MISSING_DIST',
  PUBLISH_FILES_MISSING_SCHEMAS: 'PUBLISH_FILES_MISSING_SCHEMAS',
  PUBLISH_HAS_DIST_NO_BUILD: 'PUBLISH_HAS_DIST_NO_BUILD',
  PUBLISH_NO_BUILD_SCRIPT: 'PUBLISH_NO_BUILD_SCRIPT',
  PUBLISH_NO_DIST_INDEX: 'PUBLISH_NO_DIST_INDEX',
  PUBLISH_NO_EXPORTS: 'PUBLISH_NO_EXPORTS',
  PUBLISH_NO_FILES: 'PUBLISH_NO_FILES',
  PUBLISH_NO_NAME: 'PUBLISH_NO_NAME',
  PUBLISH_NO_TSCONFIG_BUILD: 'PUBLISH_NO_TSCONFIG_BUILD',
  PUBLISH_NO_TYPES: 'PUBLISH_NO_TYPES',
  PUBLISH_NO_VERSION: 'PUBLISH_NO_VERSION',
  PUBLISH_PRIVATE_FLAG: 'PUBLISH_PRIVATE_FLAG',
  PUBLISH_TYPES_MISSING_FILE: 'PUBLISH_TYPES_MISSING_FILE',
  PUBLISH_WORKSPACE_DEP: 'PUBLISH_WORKSPACE_DEP',
});

// ---------------------------------------------------------------------------
// classifyPublishIntent
// ---------------------------------------------------------------------------

/**
 * Heuristics:
 *   - 'app'        — uses Vite (`vite` in scripts.dev or scripts.build).
 *   - 'internal'   — name contains 'integration-tests', or no `main` /
 *                    `exports` / `bin` (nothing to publish).
 *   - 'publishable' — anything else.
 *
 * @param {object} pkg  parsed package.json
 * @param {string} dirName  directory under packages/
 */
export function classifyPublishIntent(pkg, dirName) {
  const scripts = pkg.scripts ?? {};
  const usesVite =
    typeof scripts.dev === 'string' && scripts.dev.includes('vite');
  const buildIsVite =
    typeof scripts.build === 'string' && scripts.build.includes('vite');
  if (usesVite || buildIsVite) return 'app';

  const name = typeof pkg.name === 'string' ? pkg.name : '';
  if (name.includes('integration-tests') || dirName.includes('integration-tests')) {
    return 'internal';
  }

  const hasExports = pkg.exports != null;
  const hasBin = pkg.bin != null;
  const hasMain = typeof pkg.main === 'string';
  if (!hasExports && !hasBin && !hasMain) return 'internal';

  return 'publishable';
}

// ---------------------------------------------------------------------------
// collectWorkspaceDependencies
// ---------------------------------------------------------------------------

const DEP_SECTIONS = Object.freeze([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

/**
 * Returns every internal (`@plccopilot/*`) dep across all 4 sections,
 * flagging which ones use the `workspace:` protocol. Non-internal
 * external deps are intentionally ignored.
 */
export function collectWorkspaceDependencies(pkg) {
  const out = [];
  for (const section of DEP_SECTIONS) {
    const block = pkg[section];
    if (!block || typeof block !== 'object') continue;
    for (const [name, range] of Object.entries(block)) {
      if (!name.startsWith('@plccopilot/')) continue;
      const r = String(range);
      out.push({
        name,
        range: r,
        section,
        isWorkspaceProtocol: r.startsWith('workspace:'),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// readPackageInfo (filesystem)
// ---------------------------------------------------------------------------

/**
 * Reads `<dir>/package.json` plus a handful of well-known siblings so
 * the analyser doesn't redo filesystem stat() calls.
 */
export function readPackageInfo(packageDir) {
  const pkgJsonPath = join(packageDir, 'package.json');
  const raw = readFileSync(pkgJsonPath, 'utf-8');
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `cannot parse ${pkgJsonPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  return {
    dir: packageDir.split(/[\\/]/).pop(),
    packageDir,
    pkg,
    hasSrcIndex: existsSync(join(packageDir, 'src', 'index.ts')),
    hasDistIndex: existsSync(join(packageDir, 'dist', 'index.js')),
    hasDistTypes: existsSync(join(packageDir, 'dist', 'index.d.ts')),
    hasTsconfigBuild: existsSync(join(packageDir, 'tsconfig.build.json')),
    hasTsconfig: existsSync(join(packageDir, 'tsconfig.json')),
    hasViteConfig: existsSync(join(packageDir, 'vite.config.ts')),
    hasVitestConfig: existsSync(join(packageDir, 'vitest.config.ts')),
    hasSchemasDir: existsSync(join(packageDir, 'schemas')),
    distExists: existsSync(join(packageDir, 'dist')),
  };
}

// ---------------------------------------------------------------------------
// discoverPackages
// ---------------------------------------------------------------------------

/**
 * Lists immediate subdirectories of `packagesRoot` containing a
 * package.json, sorted alphabetically by directory name.
 */
export function discoverPackages(packagesRoot) {
  const entries = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const out = [];
  for (const name of entries) {
    const pkgJsonPath = join(packagesRoot, name, 'package.json');
    if (existsSync(pkgJsonPath) && statSync(pkgJsonPath).isFile()) {
      out.push(join(packagesRoot, name));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// analyzePackage  (pure: takes a PackageInfo, returns findings + summary)
// ---------------------------------------------------------------------------

function makeFinding(level, code, message, recommendation) {
  return { level, code, message, recommendation };
}

function rootExportTarget(exportsField) {
  if (!exportsField || typeof exportsField !== 'object') return null;
  const entry = exportsField['.'];
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    return entry.default ?? entry.import ?? entry.require ?? entry.types ?? null;
  }
  return null;
}

function schemaSubpathExports(exportsField) {
  if (!exportsField || typeof exportsField !== 'object') return [];
  return Object.keys(exportsField).filter((k) => k.startsWith('./schemas/'));
}

export function analyzePackage(info) {
  const { pkg, packageDir } = info;
  const dirName = info.dir;
  const intent = classifyPublishIntent(pkg, dirName);
  const findings = [];
  const wsDeps = collectWorkspaceDependencies(pkg);
  const internalDeps = wsDeps.map((d) => d.name).filter((n, i, a) => a.indexOf(n) === i);

  // -------- always-on info --------

  if (pkg.bin && typeof pkg.bin === 'object' && Object.keys(pkg.bin).length > 0) {
    findings.push(
      makeFinding(
        'info',
        FINDING_CODES.HAS_BIN,
        `package declares bin entries: ${Object.keys(pkg.bin).join(', ')}`,
        null,
      ),
    );
  }
  const schemaExports = schemaSubpathExports(pkg.exports);
  if (schemaExports.length > 0) {
    findings.push(
      makeFinding(
        'info',
        FINDING_CODES.HAS_SCHEMA_EXPORTS,
        `package declares ${schemaExports.length} schema subpath exports`,
        null,
      ),
    );
  }
  if (internalDeps.length > 0) {
    findings.push(
      makeFinding(
        'info',
        FINDING_CODES.INTERNAL_DEP,
        `depends on internal packages: ${internalDeps.join(', ')}`,
        null,
      ),
    );
  }

  // -------- intent-specific --------

  if (intent === 'app') {
    findings.push(
      makeFinding(
        'info',
        FINDING_CODES.APP_PRIVATE,
        'Vite app — built and served, not published as an npm package.',
        null,
      ),
    );
    return { intent, internalDeps, findings };
  }

  if (intent === 'internal') {
    if (dirName.includes('integration-tests') || (pkg.name ?? '').includes('integration-tests')) {
      findings.push(
        makeFinding(
          'info',
          FINDING_CODES.INTEGRATION_TESTS_HARNESS,
          'cross-backend integration test harness; no npm publish surface.',
          null,
        ),
      );
    } else {
      findings.push(
        makeFinding(
          'info',
          FINDING_CODES.INTERNAL_PRIVATE,
          'internal package with no exports / bin; not intended for publish.',
          null,
        ),
      );
    }
    return { intent, internalDeps, findings };
  }

  // ---- intent === 'publishable' ----

  if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
    findings.push(
      makeFinding(
        'blocker',
        FINDING_CODES.PUBLISH_NO_NAME,
        'package.json is missing the "name" field.',
        'Set "name" to the public scope-qualified package name.',
      ),
    );
  }
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    findings.push(
      makeFinding(
        'blocker',
        FINDING_CODES.PUBLISH_NO_VERSION,
        'package.json is missing the "version" field.',
        'Set "version" before any publish.',
      ),
    );
  }
  if (pkg.private === true) {
    findings.push(
      makeFinding(
        'blocker',
        FINDING_CODES.PUBLISH_PRIVATE_FLAG,
        '"private": true blocks `npm publish`.',
        'Remove "private" (or set to false) once the package is publish-ready.',
      ),
    );
  }
  if (pkg.exports == null) {
    findings.push(
      makeFinding(
        'blocker',
        FINDING_CODES.PUBLISH_NO_EXPORTS,
        'no "exports" field — modern consumers cannot resolve subpaths reliably.',
        'Declare an "exports" object pointing at compiled dist entries.',
      ),
    );
  }

  // -------- exports['.'] target --------
  const rootTarget = rootExportTarget(pkg.exports);
  if (typeof rootTarget === 'string') {
    if (rootTarget.includes('/src/') || rootTarget.endsWith('.ts')) {
      findings.push(
        makeFinding(
          'warning',
          FINDING_CODES.PUBLISH_EXPORTS_POINTS_TO_SRC,
          `exports["."] points at source (${rootTarget}); a published consumer cannot load TypeScript directly.`,
          'Switch to a compiled JS entry (e.g., "./dist/index.js") with a paired ".d.ts" before publish.',
        ),
      );
    } else if (rootTarget.includes('/dist/')) {
      const distEntry = resolve(packageDir, rootTarget.replace(/^\.\//, ''));
      if (!existsSync(distEntry)) {
        findings.push(
          makeFinding(
            'blocker',
            FINDING_CODES.PUBLISH_EXPORTS_TO_DIST_MISSING_DIST,
            `exports["."] points at "${rootTarget}" but ${rootTarget} does not exist.`,
            'Run the build step that produces the dist entry before packing/publishing.',
          ),
        );
      }
    }
  }

  // -------- files field --------
  const files = Array.isArray(pkg.files) ? pkg.files : null;
  if (files === null) {
    findings.push(
      makeFinding(
        'warning',
        FINDING_CODES.PUBLISH_NO_FILES,
        'no "files" array — npm will fall back to .npmignore / default rules.',
        'Declare an explicit "files" allowlist (e.g., ["dist", "schemas"]).',
      ),
    );
  } else {
    if (files.includes('src')) {
      findings.push(
        makeFinding(
          'warning',
          FINDING_CODES.PUBLISH_FILES_INCLUDES_SRC,
          '"files" includes "src" — source TS leaks into the tarball.',
          'Drop "src" from "files"; ship only compiled artifacts.',
        ),
      );
    }
    const exportsTouchesDist =
      typeof rootTarget === 'string' && rootTarget.includes('/dist/');
    const binTouchesDist = pkg.bin
      ? Object.values(pkg.bin).some(
          (p) => typeof p === 'string' && p.includes('dist/'),
        )
      : false;
    if ((exportsTouchesDist || binTouchesDist) && !files.includes('dist')) {
      findings.push(
        makeFinding(
          'blocker',
          FINDING_CODES.PUBLISH_FILES_MISSING_DIST,
          '"exports"/"bin" reference dist/ but "files" does not include "dist".',
          'Add "dist" to the "files" array.',
        ),
      );
    }
    if (schemaExports.length > 0 && !files.includes('schemas')) {
      findings.push(
        makeFinding(
          'blocker',
          FINDING_CODES.PUBLISH_FILES_MISSING_SCHEMAS,
          '"exports" expose schema subpaths but "files" does not include "schemas".',
          'Add "schemas" to the "files" array.',
        ),
      );
    }
  }

  // -------- runtime workspace deps --------
  const runtimeWorkspace = wsDeps.filter(
    (d) => d.section === 'dependencies' && d.isWorkspaceProtocol,
  );
  for (const dep of runtimeWorkspace) {
    findings.push(
      makeFinding(
        'blocker',
        FINDING_CODES.PUBLISH_WORKSPACE_DEP,
        `runtime dependency on ${dep.name} via "${dep.range}".`,
        'Replace "workspace:*" with a published semver range, or rely on pnpm publish rewriting (verify with consumer-install smoke).',
      ),
    );
  }

  // -------- build readiness --------
  const scripts = pkg.scripts ?? {};
  if (!info.hasTsconfigBuild && info.hasSrcIndex) {
    findings.push(
      makeFinding(
        'warning',
        FINDING_CODES.PUBLISH_NO_TSCONFIG_BUILD,
        'no tsconfig.build.json — package has no dedicated emit configuration.',
        'Add a tsconfig.build.json that emits to dist/ (mirror packages/cli/tsconfig.build.json).',
      ),
    );
  }
  if (!scripts.build) {
    findings.push(
      makeFinding(
        'warning',
        FINDING_CODES.PUBLISH_NO_BUILD_SCRIPT,
        'no "build" script — nothing produces the dist/ a publish would ship.',
        'Add `"build": "tsc -p tsconfig.build.json"` (or equivalent).',
      ),
    );
  }
  if (info.distExists && !scripts.build) {
    findings.push(
      makeFinding(
        'warning',
        FINDING_CODES.PUBLISH_HAS_DIST_NO_BUILD,
        'dist/ exists but there is no "build" script to regenerate it.',
        'Add a "build" script so dist/ is reproducible.',
      ),
    );
  }
  if (!info.hasDistIndex) {
    findings.push(
      makeFinding(
        'warning',
        FINDING_CODES.PUBLISH_NO_DIST_INDEX,
        'dist/index.js missing on disk; run the build step.',
        'Run `pnpm --filter <pkg> build` (or set up the build script first).',
      ),
    );
  }
  if (!info.hasDistTypes && typeof pkg.types !== 'string') {
    findings.push(
      makeFinding(
        'warning',
        FINDING_CODES.PUBLISH_NO_TYPES,
        'no "types" field and no dist/index.d.ts; consumers get untyped imports.',
        'Emit declarations (set declaration:true in tsconfig.build.json) and add a "types" entry.',
      ),
    );
  }

  // -------- bin / types path existence --------
  if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [bin, target] of Object.entries(pkg.bin)) {
      if (typeof target !== 'string') continue;
      const abs = resolve(packageDir, target.replace(/^\.\//, ''));
      if (!existsSync(abs)) {
        findings.push(
          makeFinding(
            'blocker',
            FINDING_CODES.PUBLISH_BIN_MISSING_FILE,
            `bin "${bin}" points at "${target}" but ${target} does not exist on disk.`,
            'Run the build script that emits the bin file before packing.',
          ),
        );
      }
    }
  }
  if (typeof pkg.types === 'string') {
    const abs = resolve(packageDir, pkg.types.replace(/^\.\//, ''));
    if (!existsSync(abs)) {
      findings.push(
        makeFinding(
          'blocker',
          FINDING_CODES.PUBLISH_TYPES_MISSING_FILE,
          `"types" points at "${pkg.types}" but the file is absent.`,
          'Emit declarations during the build step.',
        ),
      );
    }
  }

  return { intent, internalDeps, findings };
}

// ---------------------------------------------------------------------------
// dependency graph + topo sort
// ---------------------------------------------------------------------------

/**
 * Builds an adjacency map keyed by package name, listing the internal
 * deps that name uses (regardless of section; both runtime and dev).
 */
export function buildDependencyGraph(packages) {
  const graph = new Map();
  const knownNames = new Set(packages.map((p) => p.pkg.name));
  for (const p of packages) {
    const deps = collectWorkspaceDependencies(p.pkg)
      .map((d) => d.name)
      .filter((n) => knownNames.has(n));
    graph.set(p.pkg.name, Array.from(new Set(deps)).sort());
  }
  return graph;
}

/**
 * Kahn's algorithm with alphabetical tie-break. Returns either an
 * `order` array (success) or a `cycle` array (the names involved in
 * a cycle, when detected).
 */
export function topoSort(graph, names) {
  const indeg = new Map();
  const adj = new Map();
  const set = new Set(names);
  for (const n of names) {
    indeg.set(n, 0);
    adj.set(n, []);
  }
  for (const n of names) {
    for (const dep of graph.get(n) ?? []) {
      if (!set.has(dep)) continue;
      // Edge: dep -> n (build dep before n).
      adj.get(dep).push(n);
      indeg.set(n, (indeg.get(n) ?? 0) + 1);
    }
  }
  const ready = [...names].filter((n) => (indeg.get(n) ?? 0) === 0).sort();
  const order = [];
  while (ready.length > 0) {
    const n = ready.shift();
    order.push(n);
    for (const m of adj.get(n)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) {
        ready.push(m);
        ready.sort();
      }
    }
  }
  if (order.length < names.length) {
    return { cycle: names.filter((n) => (indeg.get(n) ?? 0) > 0) };
  }
  return { order };
}

// ---------------------------------------------------------------------------
// auditWorkspace
// ---------------------------------------------------------------------------

export function auditWorkspace(repoRoot) {
  const packagesRoot = join(repoRoot, 'packages');
  const dirs = discoverPackages(packagesRoot);
  const packages = dirs.map((d) => readPackageInfo(d));

  const analyses = packages.map((info) => {
    const a = analyzePackage(info);
    return {
      info,
      intent: a.intent,
      internalDeps: a.internalDeps,
      findings: a.findings,
    };
  });

  const graph = buildDependencyGraph(packages);
  const publishableNames = analyses
    .filter((a) => a.intent === 'publishable')
    .map((a) => a.info.pkg.name);
  const topo = topoSort(graph, publishableNames);

  const summary = countFindings(analyses);

  return {
    repoRoot,
    packagesRoot,
    packages: analyses,
    graph,
    publishBuildOrder: topo.order ?? [],
    cycle: topo.cycle ?? null,
    summary,
  };
}

function countFindings(analyses) {
  let publishable = 0,
    internal = 0,
    apps = 0;
  let blockers = 0,
    warnings = 0,
    infos = 0;
  for (const a of analyses) {
    if (a.intent === 'publishable') publishable++;
    else if (a.intent === 'internal') internal++;
    else if (a.intent === 'app') apps++;
    for (const f of a.findings) {
      if (f.level === 'blocker') blockers++;
      else if (f.level === 'warning') warnings++;
      else infos++;
    }
  }
  return {
    package_count: analyses.length,
    publishable_candidates: publishable,
    internal,
    apps,
    blockers,
    warnings,
    infos,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering (deterministic — no timestamp)
// ---------------------------------------------------------------------------

export function renderMarkdownReport(audit) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push('# PLC Copilot Publishability Audit');
  push();
  push('This file is generated by `pnpm publish:audit`. Do not edit by hand —');
  push('any drift fails CI via `pnpm publish:audit --check`.');
  push();
  push('## Summary');
  push();
  push('| Metric | Count |');
  push('| --- | ---: |');
  push(`| Packages | ${audit.summary.package_count} |`);
  push(`| Publishable candidates | ${audit.summary.publishable_candidates} |`);
  push(`| Internal packages | ${audit.summary.internal} |`);
  push(`| Apps | ${audit.summary.apps} |`);
  push(`| Blockers | ${audit.summary.blockers} |`);
  push(`| Warnings | ${audit.summary.warnings} |`);
  push(`| Infos | ${audit.summary.infos} |`);
  push();

  push('## Recommended publish build order');
  push();
  if (audit.cycle && audit.cycle.length > 0) {
    push(
      `> Dependency cycle detected among publishable packages: ${audit.cycle.join(
        ', ',
      )}. The build order is undefined until the cycle is broken.`,
    );
  } else if (audit.publishBuildOrder.length === 0) {
    push('> No publishable candidates discovered.');
  } else {
    audit.publishBuildOrder.forEach((name, i) => {
      push(`${i + 1}. \`${name}\``);
    });
  }
  push();

  push('## Package matrix');
  push();
  push(
    '| Package | Intent | Private | Exports | Files | Dist JS | Types | Workspace deps | Blockers | Warnings |',
  );
  push(
    '| --- | --- | :---: | :---: | :---: | :---: | :---: | ---: | ---: | ---: |',
  );

  const sorted = [...audit.packages].sort((a, b) =>
    a.info.dir.localeCompare(b.info.dir),
  );
  for (const a of sorted) {
    const pkg = a.info.pkg;
    const blockers = a.findings.filter((f) => f.level === 'blocker').length;
    const warnings = a.findings.filter((f) => f.level === 'warning').length;
    const wsDeps = collectWorkspaceDependencies(pkg).length;
    const yesNo = (b) => (b ? 'yes' : 'no');
    const exportsCell = pkg.exports == null ? 'no' : 'yes';
    const filesCell = Array.isArray(pkg.files) ? 'yes' : 'no';
    push(
      `| \`${pkg.name ?? a.info.dir}\` | ${a.intent} | ${yesNo(
        pkg.private === true,
      )} | ${exportsCell} | ${filesCell} | ${yesNo(a.info.hasDistIndex)} | ${yesNo(
        a.info.hasDistTypes,
      )} | ${wsDeps} | ${blockers} | ${warnings} |`,
    );
  }
  push();

  push('## Findings by package');
  push();

  for (const a of sorted) {
    const pkg = a.info.pkg;
    const heading = `\`${pkg.name ?? a.info.dir}\` (\`packages/${a.info.dir}\`)`;
    push(`### ${heading}`);
    push();
    push(`Intent: **${a.intent}**.`);
    if (a.internalDeps.length > 0) {
      push(`Internal deps: ${a.internalDeps.map((n) => `\`${n}\``).join(', ')}.`);
    }
    push();

    for (const level of ['blocker', 'warning', 'info']) {
      const subset = a.findings.filter((f) => f.level === level);
      if (subset.length === 0) continue;
      const heading2 =
        level === 'blocker'
          ? 'Blockers'
          : level === 'warning'
            ? 'Warnings'
            : 'Infos';
      push(`#### ${heading2}`);
      push();
      for (const f of subset) {
        push(`- **${f.code}** — ${f.message}`);
        if (f.recommendation) push(`  - _Recommendation:_ ${f.recommendation}`);
      }
      push();
    }
  }

  push('## Interpretation');
  push();
  push('### Current state');
  push();
  if (audit.summary.blockers === 0) {
    push(
      'No publish blockers reported. Every publishable candidate has a build, types, and resolvable dependencies.',
    );
  } else {
    push(
      `${audit.summary.blockers} publish blockers across ${audit.summary.publishable_candidates} candidate packages. None of the publishable candidates can ship to npm as-is — they all carry the workspace-only constraints below.`,
    );
  }
  push();
  push(
    'The `@plccopilot/cli` package additionally has the smoke chain from sprints 53–55 verifying its dist, npm pack manifest, and real tarball runtime — but the runtime today only resolves because the workspace lays down `node_modules/@plccopilot/*` symlinks pointing at sibling sources. A real consumer doing `npm install <tgz>` would still fail until the rest of the graph emits compiled JS.',
  );
  push();
  push('### Minimum path to a consumer-install smoke');
  push();
  push(
    '1. **Sprint 57** — add `tsconfig.build.json` + `build` script + `dist/` exports for `@plccopilot/pir` and `@plccopilot/codegen-core`.',
  );
  push(
    '2. **Sprint 58** — same treatment for the vendor codegen packages (`codegen-codesys`, `codegen-rockwell`, `codegen-siemens`), in topological order.',
  );
  push(
    '3. **Sprint 59** — flip the `exports` / `main` / `types` of every publishable package to dist (with a workspace-friendly conditional export so source-of-truth still works inside the monorepo).',
  );
  push(
    '4. **Sprint 60** — drop `private: true` on the publishable candidates, decide how `workspace:*` rewrites at pack time (verify pnpm pack vs. npm pack), and add the consumer-install smoke (`npm install <tgz>` in a clean temp project).',
  );
  push();
  push(
    'This audit will keep flagging the same blockers until each step lands. `pnpm publish:audit` after each sprint should show the count dropping.',
  );
  push();

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// JSON rendering
// ---------------------------------------------------------------------------

export function buildJsonReport(audit, generatedAt = new Date().toISOString()) {
  const sorted = [...audit.packages].sort((a, b) =>
    a.info.dir.localeCompare(b.info.dir),
  );
  return {
    generated_at: generatedAt,
    package_count: audit.summary.package_count,
    summary: audit.summary,
    build_order: audit.publishBuildOrder,
    cycle: audit.cycle,
    packages: sorted.map((a) => {
      const pkg = a.info.pkg;
      return {
        dir: a.info.dir,
        name: pkg.name ?? null,
        version: pkg.version ?? null,
        private: pkg.private === true,
        publish_intent: a.intent,
        has_tsconfig_build: a.info.hasTsconfigBuild,
        has_dist_index: a.info.hasDistIndex,
        has_dist_types: a.info.hasDistTypes,
        has_src_index: a.info.hasSrcIndex,
        has_vite_config: a.info.hasViteConfig,
        has_schemas_dir: a.info.hasSchemasDir,
        files: Array.isArray(pkg.files) ? pkg.files : null,
        exports_keys:
          pkg.exports && typeof pkg.exports === 'object'
            ? Object.keys(pkg.exports).sort()
            : null,
        bin_keys:
          pkg.bin && typeof pkg.bin === 'object' ? Object.keys(pkg.bin).sort() : null,
        scripts_keys: pkg.scripts ? Object.keys(pkg.scripts).sort() : [],
        workspace_dependencies: collectWorkspaceDependencies(pkg).sort(
          (x, y) =>
            x.section.localeCompare(y.section) || x.name.localeCompare(y.name),
        ),
        internal_dependencies: a.internalDeps.slice().sort(),
        findings: a.findings.map((f) => ({ ...f })),
      };
    }),
  };
}
