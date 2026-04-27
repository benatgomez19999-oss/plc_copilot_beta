#!/usr/bin/env node
// Sprint 62 — `pnpm release:notes`.
//
// Modes:
//   pnpm release:notes                       Markdown patch notes to stdout
//   pnpm release:notes --bump minor|major    bump-style notes
//   pnpm release:notes --version 0.2.0       exact target
//   pnpm release:notes --json                JSON shape
//   pnpm release:notes --out FILE.md         write Markdown to FILE
//   pnpm release:notes --help

process.noDeprecation = true;

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadReleaseWorkspace } from './release-plan-lib.mjs';
import {
  buildJsonReleaseNotes,
  buildReleaseNotes,
  renderMarkdownReleaseNotes,
} from './release-notes-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

function die(message, code = 1) {
  process.stderr.write(`release-notes: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { bump: null, version: null, json: false, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--bump') {
      const next = argv[i + 1];
      if (!next) die('--bump requires patch|minor|major');
      out.bump = next;
      i++;
    } else if (a.startsWith('--bump=')) {
      out.bump = a.slice('--bump='.length);
    } else if (a === '--version') {
      const next = argv[i + 1];
      if (!next) die('--version requires X.Y.Z');
      out.version = next;
      i++;
    } else if (a.startsWith('--version=')) {
      out.version = a.slice('--version='.length);
    } else if (a === '--out') {
      const next = argv[i + 1];
      if (!next) die('--out requires a path');
      out.out = resolve(process.cwd(), next);
      i++;
    } else if (a.startsWith('--out=')) {
      out.out = resolve(process.cwd(), a.slice('--out='.length));
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  if (out.bump && out.version) die('--bump and --version are mutually exclusive');
  if (out.bump && !['patch', 'minor', 'major'].includes(out.bump)) {
    die(`--bump must be patch|minor|major (got ${JSON.stringify(out.bump)})`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`pnpm release:notes [--bump patch|minor|major | --version X.Y.Z] [--json] [--out FILE.md]
`);
  process.exit(0);
}

const target = args.version
  ? { kind: 'exact', version: args.version }
  : { kind: 'bump', bump: args.bump ?? 'patch' };

const workspace = loadReleaseWorkspace(REPO_ROOT);
const notes = buildReleaseNotes(workspace, target);

if (args.json) {
  process.stdout.write(JSON.stringify(buildJsonReleaseNotes(notes), null, 2) + '\n');
  process.exit(notes.ok ? 0 : 1);
}

const markdown = renderMarkdownReleaseNotes(notes);
if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, markdown, 'utf-8');
  process.stdout.write(`Release notes written to ${args.out}\n`);
} else {
  process.stdout.write(markdown);
}
process.exit(notes.ok ? 0 : 1);
