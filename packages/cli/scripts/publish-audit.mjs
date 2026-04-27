#!/usr/bin/env node
/**
 * Sprint 56 — `pnpm publish:audit` runner.
 *
 * Modes:
 *   pnpm publish:audit                    — write `docs/publishability-audit.md`
 *   pnpm publish:audit --check            — fail if the committed report is stale
 *   pnpm publish:audit --json             — print a JSON audit (no file IO)
 *   pnpm publish:audit --out <path.md>    — write the markdown to a custom path
 *
 * Exit codes:
 *   0  every requested action succeeded (or report was up-to-date for --check)
 *   1  unexpected error (parse failure, IO error)
 *   2  `--check` only — committed report drifted from the live audit
 *
 * Dependencies: Node built-ins only. The actual logic lives in
 * `publish-audit-lib.mjs` and is shared with the Vitest spec.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditWorkspace,
  buildJsonReport,
  renderMarkdownReport,
} from './publish-audit-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(CLI_ROOT, '..', '..');
const DEFAULT_REPORT = resolve(REPO_ROOT, 'docs', 'publishability-audit.md');

function parseArgs(argv) {
  const out = { check: false, json: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--json') out.json = true;
    else if (a === '--out') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        die(`--out requires a path argument`);
      }
      out.out = resolve(process.cwd(), next);
      i++;
    } else if (a.startsWith('--out=')) {
      out.out = resolve(process.cwd(), a.slice('--out='.length));
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  if (out.check && out.json) die('--check and --json are mutually exclusive');
  if (out.check && out.out) die('--check and --out are mutually exclusive');
  return out;
}

function die(message, code = 1) {
  console.error(`publish-audit: ${message}`);
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
const audit = auditWorkspace(REPO_ROOT);

if (args.json) {
  const json = buildJsonReport(audit);
  process.stdout.write(JSON.stringify(json, null, 2) + '\n');
  process.exit(0);
}

const markdown = renderMarkdownReport(audit);

if (args.check) {
  if (!existsSync(DEFAULT_REPORT)) {
    die(
      `report not found at ${DEFAULT_REPORT}; run \`pnpm publish:audit\` to generate it.`,
      2,
    );
  }
  const onDisk = readFileSync(DEFAULT_REPORT, 'utf-8');
  if (onDisk === markdown) {
    process.stdout.write('Publishability audit is up to date.\n');
    process.exit(0);
  }
  process.stderr.write(
    'Publishability audit is out of date. Run: pnpm publish:audit\n',
  );
  process.exit(2);
}

const target = args.out ?? DEFAULT_REPORT;
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, markdown, 'utf-8');
process.stdout.write(`Publishability audit written to ${target}\n`);
process.exit(0);
