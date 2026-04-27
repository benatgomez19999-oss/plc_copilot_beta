import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { stableJson } from '@plccopilot/codegen-core';
import { CliError, formatError } from '../errors.js';
import {
  cliSchemaFileName,
  getCliJsonSchema,
  getCliJsonSchemaEntries,
  isCliSchemaName,
  listCliSchemaNames,
  type CliSchemaName,
} from '../json-schema.js';
import type { CliIO } from '../cli.js';

export interface SchemaArgs {
  /**
   * Sprint 46 — schema id. Defaults to `'cli-result'` when omitted so
   * `plccopilot schema` (no flags) prints the umbrella schema for
   * every `--json` payload.
   */
  name?: string;
  /**
   * Sprint 50 — when set, writes the schema(s) to disk inside the
   * given directory and skips printing JSON to stdout. Without
   * `--name`, every schema in `getCliJsonSchemaEntries()` is written;
   * with `--name`, only the matching one is written.
   */
  out?: string;
  /**
   * Sprint 52 — read-only sync guard. Compares the static schema
   * file(s) inside `<dir>` against `stableJson(SCHEMA_CONST)`:
   *
   *   - exit 0 → directory is in sync (no writes)
   *   - exit 1 → missing / changed / unexpected file (no writes)
   *
   * Without `--name`, every published schema is compared AND any
   * non-schema file in the directory counts as `unexpected`. With
   * `--name`, only that single file is compared and other files in
   * the directory are ignored (so a selective check on
   * `packages/cli/schemas/` doesn't fail because of its siblings).
   *
   * Mutually exclusive with `--out`.
   */
  check?: string;
}

/**
 * Run the `schema` command.
 *
 * Default mode (no `--out`): prints a JSON Schema (draft 2020-12) to
 * stdout. The output is NOT a `CliJsonResult` — this subcommand
 * exists specifically so CI / agents can validate `--json` outputs.
 *
 * `--out` mode (sprint 50): writes one or many schema files to the
 * given directory. Output is byte-identical to the static
 * `packages/cli/schemas/*.schema.json` snapshots, so the same files
 * can be regenerated portably across Windows / Unix without shell
 * redirection.
 *
 * Exit codes:
 *   0 — schema printed (or files written)
 *   1 — unknown schema name, or --out path is an existing non-directory
 */
export async function runSchema(
  args: SchemaArgs,
  io: CliIO,
): Promise<number> {
  // Sprint 52 — write-mode and check-mode are mutually exclusive.
  // Catch the conflict before resolving the schema name so a typo in
  // `--name` doesn't shadow the more important "wrong CLI usage"
  // signal.
  if (args.out !== undefined && args.check !== undefined) {
    io.error(
      formatError(
        new CliError('--out and --check cannot be used together', 1),
      ),
    );
    return 1;
  }

  const name = args.name ?? 'cli-result';
  if (!isCliSchemaName(name)) {
    const valid = listCliSchemaNames().join(', ');
    io.error(
      formatError(
        new CliError(
          `unknown schema "${name}". Valid: ${valid}`,
          1,
        ),
      ),
    );
    return 1;
  }

  if (args.check !== undefined) {
    return checkSchemasOnDisk(args.name, args.check, name, io);
  }

  if (args.out !== undefined) {
    return writeSchemasToDisk(args.name, args.out, name, io);
  }

  const schema = getCliJsonSchema(name);
  io.log(stableJson(schema));
  return 0;
}

// =============================================================================
// Sprint 50 — --out file writing
// =============================================================================

function writeSchemasToDisk(
  rawName: string | undefined,
  outRaw: string,
  resolvedName: CliSchemaName,
  io: CliIO,
): number {
  let outDirAbs: string;
  try {
    outDirAbs = resolveOutputDir(outRaw);
  } catch (e) {
    io.error(formatError(e));
    return 1;
  }

  // When `--name` is supplied, write that one file; otherwise write
  // every published schema in stable order.
  const targets: readonly CliSchemaName[] =
    rawName !== undefined
      ? [resolvedName]
      : getCliJsonSchemaEntries().map((e) => e.name);

  const written: string[] = [];
  for (const name of targets) {
    let path: string;
    try {
      path = writeSchemaFile(outDirAbs, name);
    } catch (e) {
      io.error(formatError(e));
      return 1;
    }
    written.push(path);
  }

  if (written.length === 1) {
    io.log(`Wrote schema file to ${written[0]!}`);
  } else {
    io.log(`Wrote ${written.length} schema files to ${outDirAbs}`);
  }
  return 0;
}

/**
 * Resolve `--out` to an absolute path AND ensure it is (or becomes) a
 * directory. Throws `CliError` for the disallowed case where the
 * path already exists as a non-directory file.
 */
function resolveOutputDir(out: string): string {
  const abs = resolve(out);
  if (existsSync(abs)) {
    const stat = statSync(abs);
    if (!stat.isDirectory()) {
      throw new CliError(
        `--out must point to a directory: ${abs}`,
        1,
      );
    }
  } else {
    try {
      mkdirSync(abs, { recursive: true });
    } catch (e) {
      throw new CliError(
        `failed to create --out directory: ${abs}`,
        1,
        e,
      );
    }
  }
  return abs;
}

/**
 * Path-safe schema file writer. `cliSchemaFileName` is controlled by
 * the union of `CliSchemaName`, but we still defend against any
 * future drift that might let a separator or `..` slip through —
 * cheap belt-and-braces.
 */
function writeSchemaFile(outDirAbs: string, name: CliSchemaName): string {
  const fileName = cliSchemaFileName(name);
  if (
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('..') ||
    isAbsolute(fileName)
  ) {
    throw new CliError(
      `internal: refusing unsafe schema filename "${fileName}"`,
      1,
    );
  }
  const target = resolve(outDirAbs, fileName);
  const inside =
    target === outDirAbs ||
    target.startsWith(outDirAbs + sep) ||
    target.startsWith(outDirAbs + '/');
  if (!inside) {
    throw new CliError(
      `internal: schema file "${target}" escapes --out directory`,
      1,
    );
  }
  const content = stableJson(getCliJsonSchema(name));
  writeFileSync(target, content, 'utf-8');
  return target;
}

// =============================================================================
// Sprint 52 — --check read-only sync guard
// =============================================================================

interface SchemaCheckIssue {
  // Order matters: the formatter prints `missing` before `changed`
  // before `unexpected` so the output is deterministic.
  kind: 'missing' | 'changed' | 'unexpected';
  fileName: string;
}

const ISSUE_KIND_ORDER: Record<SchemaCheckIssue['kind'], number> = {
  missing: 0,
  changed: 1,
  unexpected: 2,
};

function checkSchemasOnDisk(
  rawName: string | undefined,
  checkRaw: string,
  resolvedName: CliSchemaName,
  io: CliIO,
): number {
  let dirAbs: string;
  try {
    dirAbs = resolveCheckDir(checkRaw);
  } catch (e) {
    io.error(formatError(e));
    return 1;
  }

  const expected =
    rawName !== undefined
      ? [
          {
            name: resolvedName,
            fileName: cliSchemaFileName(resolvedName),
            content: stableJson(getCliJsonSchema(resolvedName)),
          },
        ]
      : getCliJsonSchemaEntries().map((e) => ({
          name: e.name,
          fileName: e.fileName,
          content: stableJson(e.schema),
        }));

  const issues: SchemaCheckIssue[] = [];

  // missing / changed: probe every expected file once.
  for (const e of expected) {
    const path = join(dirAbs, e.fileName);
    if (!existsSync(path)) {
      issues.push({ kind: 'missing', fileName: e.fileName });
      continue;
    }
    const actual = readFileSync(path, 'utf-8');
    if (actual !== e.content) {
      issues.push({ kind: 'changed', fileName: e.fileName });
    }
  }

  // unexpected: only when checking ALL schemas. Selective `--name`
  // check explicitly ignores siblings so a one-shot validation
  // against `packages/cli/schemas/` doesn't trip over its peers.
  if (rawName === undefined) {
    const expectedSet = new Set(expected.map((e) => e.fileName));
    for (const entry of readdirSync(dirAbs).slice().sort()) {
      if (!expectedSet.has(entry)) {
        issues.push({ kind: 'unexpected', fileName: entry });
      }
    }
  }

  if (issues.length === 0) {
    if (rawName !== undefined) {
      io.log(
        `Schema file is in sync: ${join(dirAbs, expected[0]!.fileName)}`,
      );
    } else {
      io.log(`Schema files are in sync: ${dirAbs}`);
    }
    return 0;
  }

  // Deterministic ordering: missing → changed → unexpected, alpha
  // within each group.
  issues.sort((a, b) => {
    const k = ISSUE_KIND_ORDER[a.kind] - ISSUE_KIND_ORDER[b.kind];
    if (k !== 0) return k;
    return a.fileName.localeCompare(b.fileName);
  });
  const lines = issues.map((i) => `- ${i.kind}: ${i.fileName}`);
  io.error(`error: schema check failed for ${dirAbs}\n${lines.join('\n')}`);
  return 1;
}

/**
 * Resolve `--check` to an absolute path AND ensure it is an existing
 * directory. Unlike `--out`, we never create the directory: the
 * point is to guard a directory the caller (typically CI) already
 * believes exists.
 */
function resolveCheckDir(check: string): string {
  const abs = resolve(check);
  if (!existsSync(abs)) {
    throw new CliError(
      `--check must point to an existing directory: ${abs}`,
      1,
    );
  }
  const stat = statSync(abs);
  if (!stat.isDirectory()) {
    throw new CliError(
      `--check must point to an existing directory: ${abs}`,
      1,
    );
  }
  return abs;
}
